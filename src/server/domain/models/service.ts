import {
  getOpenRouterActivity,
  getOpenRouterCredits,
  getOpenRouterGenerationCost,
  listOpenRouterEndpoints,
  listOpenRouterModels,
  listOpenRouterProviders,
  type OpenRouterActivityItem,
  type OpenRouterCredits,
  type RawModel,
} from "../../providers/openrouter";

// Thin domain seam over the model providers so transport reaches them through domain (the layer
// cake forbids trpc → infra directly). sdk-mode models are the static shared catalog (returned in
// the transport layer from `shared/models`); this service owns the DYNAMIC OpenRouter catalog +
// the account-info reads (credits / activity / per-generation cost / providers / endpoints).

export interface ModelsServiceDeps {
  /** Injectable for tests (no network in `pnpm check`). */
  listRaw?: typeof listOpenRouterModels;
  credits?: typeof getOpenRouterCredits;
  activity?: typeof getOpenRouterActivity;
  generationCost?: typeof getOpenRouterGenerationCost;
  providers?: typeof listOpenRouterProviders;
  endpoints?: typeof listOpenRouterEndpoints;
}

export interface ModelsService {
  /** The live OpenRouter catalog for raw-mode selection (fetched + cached in the provider). */
  rawCatalog(): Promise<RawModel[]>;
  /** OpenRouter credit balance (total purchased + used, USD). */
  credits(): Promise<OpenRouterCredits>;
  /** Recent usage analytics (last ~30 UTC days, grouped by day/model), date normalized to dateMs. */
  activity(): Promise<OpenRouterActivityItem[]>;
  /** Authoritative per-generation cost by id (settles shortly after a turn). */
  generationCost(
    id: string,
  ): Promise<{ totalCost: number; tokensPrompt: number; tokensCompletion: number } | null>;
  /** The provider directory. */
  providers(): Promise<unknown[]>;
  /** Per-model endpoint list ("author/slug"). */
  endpoints(model: string): Promise<unknown>;
}

export function createModelsService(deps: ModelsServiceDeps = {}): ModelsService {
  const listRaw = deps.listRaw ?? listOpenRouterModels;
  const credits = deps.credits ?? getOpenRouterCredits;
  const activity = deps.activity ?? getOpenRouterActivity;
  const generationCost = deps.generationCost ?? getOpenRouterGenerationCost;
  const providers = deps.providers ?? listOpenRouterProviders;
  const endpoints = deps.endpoints ?? listOpenRouterEndpoints;
  return {
    rawCatalog: () => listRaw(),
    credits: () => credits(),
    activity: () => activity(),
    generationCost: (id) => generationCost(id),
    providers: () => providers(),
    endpoints: (model) => endpoints(model),
  };
}
