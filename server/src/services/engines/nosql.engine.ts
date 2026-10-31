import { spawn } from 'child_process';
import { createWriteStream, statSync } from 'fs';
import path from 'path';
import { BaseEngine, BackupResult, BackupOptions, TestConnectionResult, ConnectionConfig, DbInfo } from './base.engine';
import { SSHTunnel } from '../ssh.service';

/**
 * NoSQL engines via native CLIs (same philosophy as the SQL engines):
 *   MongoDB  → mongodump --archive --gzip / mongorestore --archive
 *   Redis    → redis-cli --rdb (RDB snapshot); restore is not supported
 *              (restoring an RDB requires a server restart — by design)
 *
 * Both are SSH-tunnel aware and follow the same lifecycle as the SQL
 * engines (tunnel per operation, closed in finally).
 */

abstract class CliEngine extends BaseEngine {
  /** Run a CLI command; resolves stdout, rejects with stderr on non-zero exit. */
  protected runCli(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env, timeoutMs = 300_000): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { env });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`${cmd} timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', (err) => { clearTimeout(timer); reject(err); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`${cmd} exited ${code}: ${stderr.trim().slice(0, 300)}`));
      });
    });
  }

  /** Open an SSH tunnel if configured; returns the local port to target. */
  protected async openTunnel(): Promise<{ tunnel: SSHTunnel | null; port: number }> {
    if (!this.config.sshEnabled) return { tunnel: null, port: this.config.port };
    const tunnel = new SSHTunnel(this.config);
    const localPort = await tunnel.connect();
    (this.config as any)._localPort = localPort;
    return { tunnel, port: localPort };
  }
}

export class MongoEngine extends CliEngine {
  private commonArgs(port: number): string[] {
    return [
      '--host', this.config.sshEnabled ? '127.0.0.1' : this.config.host,
      '--port', String(port),
      ...(this.config.username ? ['--username', this.config.username] : []),
      ...(this.config.password ? ['--password', this.config.password] : []),
      '--authenticationDatabase', 'admin',
      ...(this.config.sslEnabled ? ['--ssl'] : []),
      '--connectTimeoutMS=10000',
    ];
  }

  async testConnection(): Promise<TestConnectionResult> {
    const { tunnel, port } = await this.openTunnel();
    try {
      // Dump the tiny admin.system.version collection — validates auth + connectivity cheaply
      const { stdout } = await this.runCli('mongodump', [
        ...this.commonArgs(port),
        '--db', 'admin', '--collection', 'system.version',
        '--archive', '--gzip',
      ], undefined, 30_000);
      void stdout;
      return { success: true, version: 'connected', message: 'Connection successful' };
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : String(e) };
    } finally {
      tunnel?.close();
    }
  }

  async backup(outputDir: string, options: BackupOptions = {}): Promise<BackupResult> {
    const { tunnel, port } = await this.openTunnel();
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `mongodb_${this.config.database}_${timestamp}.archive.gz`;
      const filePath = path.join(outputDir, fileName);
      options.onProgress?.(5);

      await this.runCli('mongodump', [
        ...this.commonArgs(port),
        '--db', this.config.database,
        '--archive', filePath,
        '--gzip',
      ]);
      options.onProgress?.(95);
      const stats = statSync(filePath);
      options.onProgress?.(100);
      return { fileName, filePath, fileSize: stats.size };
    } finally {
      tunnel?.close();
    }
  }

  async restore(backupFilePath: string, targetDatabase?: string): Promise<void> {
    const { tunnel, port } = await this.openTunnel();
    try {
      const args = [
        ...this.commonArgs(port),
        '--archive', backupFilePath,
        '--gzip',
        '--drop',
      ];
      if (targetDatabase && targetDatabase !== this.config.database) {
        args.push('--nsFrom', `${this.config.database}.*`, '--nsTo', `${targetDatabase}.*`);
      }
      await this.runCli('mongorestore', args);
    } finally {
      tunnel?.close();
    }
  }

  async listDatabases(): Promise<string[]> {
    throw new Error('Listing databases is not supported for MongoDB yet');
  }
  async getDbInfo(): Promise<DbInfo> {
    throw new Error('Database info is not supported for MongoDB yet');
  }
  async ping(timeoutMs = 5000): Promise<{ up: boolean; latencyMs: number; error?: string }> {
    const started = Date.now();
    const { tunnel, port } = await this.openTunnel();
    try {
      await this.runCli('mongodump', [
        ...this.commonArgs(port),
        '--db', 'admin', '--collection', 'system.version',
        '--archive', '--gzip',
      ], undefined, timeoutMs);
      return { up: true, latencyMs: Date.now() - started };
    } catch (e) {
      return { up: false, latencyMs: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
    } finally {
      tunnel?.close();
    }
  }
}

export class RedisEngine extends CliEngine {
  private cliArgs(port: number): string[] {
    return [
      '-h', this.config.sshEnabled ? '127.0.0.1' : this.config.host,
      '-p', String(port),
      ...(this.config.password ? ['-a', this.config.password, '--no-auth-warning'] : []),
    ];
  }

  async testConnection(): Promise<TestConnectionResult> {
    const { tunnel, port } = await this.openTunnel();
    try {
      const { stdout } = await this.runCli('redis-cli', [...this.cliArgs(port), 'PING'], undefined, 10_000);
      if (!stdout.includes('PONG')) {
        return { success: false, message: `Unexpected reply: ${stdout.trim().slice(0, 100)}` };
      }
      // Try to surface the server version for the UI
      let version = '';
      try {
        const info = await this.runCli('redis-cli', [...this.cliArgs(port), 'INFO', 'server'], undefined, 10_000);
        const m = /redis_version:([^\r\n]+)/.exec(info.stdout);
        if (m) version = m[1].trim();
      } catch { /* version is optional */ }
      return { success: true, version, message: 'Connection successful' };
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : String(e) };
    } finally {
      tunnel?.close();
    }
  }

  async backup(outputDir: string, options: BackupOptions = {}): Promise<BackupResult> {
    const { tunnel, port } = await this.openTunnel();
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `redis_${this.config.database}_${timestamp}.rdb`;
      const filePath = path.join(outputDir, fileName);
      options.onProgress?.(10);

      // redis-cli --rdb streams a BGSAVE snapshot to the given file
      const { stderr } = await this.runCli('redis-cli', [...this.cliArgs(port), '--rdb', filePath]);
      void stderr;
      options.onProgress?.(95);
      const stats = statSync(filePath);
      options.onProgress?.(100);
      return { fileName, filePath, fileSize: stats.size };
    } finally {
      tunnel?.close();
    }
  }

  async restore(_backupFilePath: string): Promise<void> {
    throw new Error('Redis restores require a server restart with the RDB file — restore manually: stop redis, replace dump.rdb, start');
  }
  async listDatabases(): Promise<string[]> {
    return [this.config.database]; // single namespace
  }
  async getDbInfo(): Promise<DbInfo> {
    throw new Error('Database info is not supported for Redis yet');
  }
  async ping(timeoutMs = 5000): Promise<{ up: boolean; latencyMs: number; error?: string }> {
    const started = Date.now();
    const { tunnel, port } = await this.openTunnel();
    try {
      const { stdout } = await this.runCli('redis-cli', [...this.cliArgs(port), 'PING'], undefined, timeoutMs);
      if (!stdout.includes('PONG')) throw new Error(`Unexpected reply: ${stdout.trim()}`);
      return { up: true, latencyMs: Date.now() - started };
    } catch (e) {
      return { up: false, latencyMs: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
    } finally {
      tunnel?.close();
    }
  }
}

// keep the writer import referenced (parity with other engines)
void createWriteStream;
