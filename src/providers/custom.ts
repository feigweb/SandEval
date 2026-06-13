import path from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { CustomModelConfig, ModelChatRequest, ModelProvider, ModelResponse } from "../types.js";

type CustomProviderFactory =
  | ((config: CustomModelConfig) => ModelProvider | Promise<ModelProvider>)
  | ((config: CustomModelConfig) => { chat: (request: ModelChatRequest) => Promise<ModelResponse> });

export class CustomProvider implements ModelProvider {
  readonly name: string;
  private loaded?: ModelProvider;

  constructor(private readonly config: CustomModelConfig) {
    this.name = config.name;
  }

  async chat(request: ModelChatRequest): Promise<ModelResponse> {
    const provider = await this.load();
    return provider.chat(request);
  }

  private async load(): Promise<ModelProvider> {
    if (this.loaded) {
      return this.loaded;
    }

    const modulePath = path.isAbsolute(this.config.modulePath)
      ? this.config.modulePath
      : path.resolve(process.cwd(), this.config.modulePath);
    if (!existsSync(modulePath)) {
      throw new Error(
        [
          `Custom provider "${this.config.name}" module was not found: ${modulePath}`,
          "Create it with:",
          `  sandeval config scaffold-provider ${this.config.modulePath}`,
          "Then edit the generated file to call your model or local agent CLI."
        ].join("\n")
      );
    }
    const module = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
    const exportName = this.config.exportName ?? "createProvider";
    const exported = module[exportName] ?? module.default;

    if (typeof exported === "function") {
      const provider = await (exported as CustomProviderFactory)(this.config);
      if (!provider || typeof provider.chat !== "function") {
        throw new Error(`Custom provider "${this.config.name}" did not return an object with chat().`);
      }
      this.loaded = {
        name: this.config.name,
        chat: provider.chat.bind(provider)
      };
      return this.loaded;
    }

    if (exported && typeof exported === "object" && typeof (exported as ModelProvider).chat === "function") {
      const provider = exported as ModelProvider;
      this.loaded = {
        name: provider.name ?? this.config.name,
        chat: provider.chat.bind(provider)
      };
      return this.loaded;
    }

    throw new Error(
      `Custom provider "${this.config.name}" must export ${exportName}(), default(), or an object with chat().`
    );
  }
}
