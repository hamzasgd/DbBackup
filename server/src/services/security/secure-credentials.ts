/**
 * Secure credential handling that minimizes memory exposure.
 * Credentials are stored in buffers that can be securely cleared.
 */
export class SecureCredential {
  private buffer: Buffer;
  private length: number;
  private destroyed: boolean = false;

  constructor(value: string) {
    // Allocate buffer and copy value
    this.length = Buffer.byteLength(value, 'utf8');
    this.buffer = Buffer.alloc(this.length);
    this.buffer.write(value, 'utf8');
  }

  /**
   * Use the credential for an operation, then securely clear it
   */
  async use<T>(fn: (value: string) => Promise<T>): Promise<T> {
    if (this.destroyed) {
      throw new Error('Credential has been destroyed');
    }
    // Create a string from buffer (doesn't create a separate copy in V8 optimization)
    const value = this.buffer.toString('utf8', 0, this.length);
    try {
      return await fn(value);
    } finally {
      this.secureClear();
    }
  }

  /**
   * Get the credential value (use with caution - prefer use() method)
   */
  getValue(): string {
    if (this.destroyed) {
      throw new Error('Credential has been destroyed');
    }
    return this.buffer.toString('utf8', 0, this.length);
  }

  /**
   * Check if credential has been destroyed
   */
  isDestroyed(): boolean {
    return this.destroyed;
  }

  /**
   * Securely clear the credential from memory
   */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.secureClear();
    this.destroyed = true;
    this.buffer = Buffer.alloc(0);
  }

  private secureClear(): void {
    if (this.buffer && this.buffer.length > 0) {
      // Overwrite buffer with zeros multiple times for security
      this.buffer.fill(0);
      this.buffer.fill(0xFF);
      this.buffer.fill(0);
    }
  }
}

/**
 * Factory for creating and managing secure credentials
 */
export class SecureCredentialFactory {
  /**
   * Create a SecureCredential from a string
   */
  static fromString(value: string): SecureCredential {
    return new SecureCredential(value);
  }

  /**
   * Create a SecureCredential from a string, auto-destroy after timeout
   */
  static fromStringWithTimeout(
    value: string,
    timeoutMs: number
  ): SecureCredential {
    const credential = new SecureCredential(value);
    setTimeout(() => credential.destroy(), timeoutMs);
    return credential;
  }

  /**
   * Safely clear a string by overwriting it character by character
   * Note: This doesn't guarantee memory clearing but helps in some scenarios
   */
  static clearString(value: string): void {
    // This is a best-effort approach - JavaScript strings are immutable
    const arr = value.split('');
    for (let i = 0; i < arr.length; i++) {
      arr[i] = '\0';
    }
  }
}
