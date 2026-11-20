/** Where the dump/restore tools run: here through the SSH tunnel, or on the SSH server. */
export type ToolStrategy = 'TUNNEL' | 'SSH_SERVER'

/** "Run on the SSH server" exists for MySQL/MariaDB connections that use SSH. */
export function sshServerStrategyAvailable(conn: { type: string; sshEnabled: boolean } | undefined): boolean {
  return !!conn && conn.sshEnabled && (conn.type === 'MYSQL' || conn.type === 'MARIADB')
}
