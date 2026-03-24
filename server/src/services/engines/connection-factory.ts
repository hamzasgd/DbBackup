/**
 * Connection Factory for DbBackup
 * Centralizes database connection creation with SSH tunnel support
 */

import * as mysql2 from 'mysql2/promise';
import { Pool, PoolClient } from 'pg';
import { SSHTunnel } from '../ssh.service';
import { decrypt, decryptIfPresent } from '../crypto.service';
import { ConnectionConfig } from './base.engine';

/** MySQL connection result with optional SSH tunnel */
export interface MySQLConnectionResult {
    connection: mysql2.Connection;
    tunnel: SSHTunnel | null;
}

/** PostgreSQL connection result with optional SSH tunnel */
export interface PostgreSQLConnectionResult {
    pool: Pool;
    client: PoolClient | null;
    tunnel: SSHTunnel | null;
}

/** Decrypted connection config for internal use */
interface DecryptedConfig extends Omit<ConnectionConfig, 'password'> {
    password?: string;
    _localPort?: number;
}

/**
 * Factory for creating database connections with SSH tunnel support
 * Abstracts away the decryption and SSH tunnel setup logic
 */
export class ConnectionFactory {
    /**
     * Create a MySQL/MariaDB connection with optional SSH tunnel
     */
    static async createMySQLConnection(
        connectionConfig: ConnectionConfig
    ): Promise<MySQLConnectionResult> {
        let tunnel: SSHTunnel | null = null;

        try {
            // Decrypt connection credentials
            const decryptedConfig = this.decryptConfig(connectionConfig);

            if (decryptedConfig.sshEnabled) {
                tunnel = new SSHTunnel(decryptedConfig);
                const localPort = await tunnel.connect();
                decryptedConfig._localPort = localPort;
            }

            const host = decryptedConfig.sshEnabled ? '127.0.0.1' : decryptedConfig.host;
            const port = decryptedConfig.sshEnabled
                ? decryptedConfig._localPort || decryptedConfig.port
                : decryptedConfig.port;

            const connection = await mysql2.createConnection({
                host,
                port,
                user: decryptedConfig.username,
                password: decryptedConfig.password,
                database: decryptedConfig.database,
                ssl: decryptedConfig.sslEnabled ? { rejectUnauthorized: false } : undefined,
                connectTimeout: decryptedConfig.connectionTimeout || 30000,
            });

            return { connection, tunnel };
        } catch (error) {
            tunnel?.close();
            throw error;
        }
    }

    /**
     * Create a PostgreSQL connection pool with optional SSH tunnel
     */
    static async createPostgreSQLPool(
        connectionConfig: ConnectionConfig
    ): Promise<PostgreSQLConnectionResult> {
        let tunnel: SSHTunnel | null = null;

        try {
            // Decrypt connection credentials
            const decryptedConfig = this.decryptConfig(connectionConfig);

            if (decryptedConfig.sshEnabled) {
                tunnel = new SSHTunnel(decryptedConfig);
                const localPort = await tunnel.connect();
                decryptedConfig._localPort = localPort;
            }

            const host = decryptedConfig.sshEnabled ? '127.0.0.1' : decryptedConfig.host;
            const port = decryptedConfig.sshEnabled
                ? decryptedConfig._localPort || decryptedConfig.port
                : decryptedConfig.port;

            const pool = new Pool({
                host,
                port,
                user: decryptedConfig.username,
                password: decryptedConfig.password,
                database: decryptedConfig.database,
                ssl: decryptedConfig.sslEnabled ? { rejectUnauthorized: false } : undefined,
                connectionTimeoutMillis: decryptedConfig.connectionTimeout || 30000,
                max: 5,
            });

            return { pool, client: null, tunnel };
        } catch (error) {
            tunnel?.close();
            throw error;
        }
    }

    /**
     * Get a PostgreSQL client from an existing pool
     */
    static async getPostgreSQLClient(pool: Pool): Promise<PoolClient> {
        return pool.connect();
    }

    /**
     * Decrypt connection configuration
     */
    private static decryptConfig(config: ConnectionConfig): DecryptedConfig {
        return {
            ...config,
            host: decrypt(config.host),
            username: decrypt(config.username),
            password: decrypt(config.password || ''),
            database: decrypt(config.database),
            sshHost: decryptIfPresent(config.sshHost) ?? undefined,
            sshUsername: decryptIfPresent(config.sshUsername) ?? undefined,
            sshPrivateKey: decryptIfPresent(config.sshPrivateKey) ?? undefined,
            sshPassphrase: decryptIfPresent(config.sshPassphrase) ?? undefined,
        };
    }

    /**
     * Close MySQL connection and SSH tunnel
     */
    static async closeMySQLConnection(result: MySQLConnectionResult): Promise<void> {
        await result.connection.end();
        result.tunnel?.close();
    }

    /**
     * Close PostgreSQL pool and SSH tunnel
     */
    static async closePostgreSQLPool(result: PostgreSQLConnectionResult): Promise<void> {
        result.client?.release();
        await result.pool.end();
        result.tunnel?.close();
    }
}
