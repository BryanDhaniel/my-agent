export class ModelNotFoundError extends Error {
  readonly modelId: string;

  constructor(modelId: string) {
    super(`Unknown model "${modelId}"`);
    this.name = "ModelNotFoundError";
    this.modelId = modelId;
  }
}

export class ModelProviderMismatchError extends Error {
  readonly modelId: string;
  readonly providerId: string;

  constructor(modelId: string, providerId: string) {
    super(`Model "${modelId}" does not belong to provider "${providerId}"`);
    this.name = "ModelProviderMismatchError";
    this.modelId = modelId;
    this.providerId = providerId;
  }
}
