// Optional module declarations for dynamically imported packages
// These packages are optional runtime dependencies

declare module '@aws-sdk/client-kms' {
  export const KMSClient: any;
  export const EncryptCommand: any;
  export const DecryptCommand: any;
}

declare module '@azure/identity' {
  export const DefaultAzureCredential: any;
}

declare module '@azure/keyvault-keys' {
  export const KeyClient: any;
}

declare module '@google-cloud/kms' {
  export const KeyManagementServiceClient: any;
}
