import { listOpenRouterModels, type RawModel } from "../../providers/openrouter";

// Thin domain seam over the model providers so transport reaches them through domain (the layer
// cake forbids trpc → infra directly). sdk-mode models are the static shared catalog (returned in
// the transport layer from `shared/models`); this service owns the DYNAMIC raw-mode catalog.

export interface ModelsServiceDeps {
  /** Injectable for tests (no network in `pnpm check`). */
  listRaw?: typeof listOpenRouterModels;
}

export interface ModelsService {
  /** The live OpenRouter catalog for raw-mode selection (fetched + cached in the provider). */
  rawCatalog(): Promise<RawModel[]>;
}

export function createModelsService(deps: ModelsServiceDeps = {}): ModelsService {
  const listRaw = deps.listRaw ?? listOpenRouterModels;
  return {
    rawCatalog: () => listRaw(),
  };
}
