import type { ModelChatRequest, ModelProvider, ModelResponse } from "../types.js";
import { estimateTokens } from "../utils.js";

export class MockProvider implements ModelProvider {
  readonly name: string;

  constructor(name = "mock") {
    this.name = name;
  }

  async chat(request: ModelChatRequest): Promise<ModelResponse> {
    const lastToolNames = request.messages.filter((message) => message.role === "tool").map((message) => message.name);
    const input = request.messages.map((message) => message.content).join("\n");

    if (input.includes("SandEval Judge")) {
      return {
        content: JSON.stringify({
          score: 88,
          summary: "The mock artifact satisfies the small Node.js task and includes a runnable start script.",
          strengths: ["Creates the requested files", "Runs a verification command"],
          weaknesses: ["Mock output is deterministic", "No extra tests beyond execution"],
          userFeedbackImpact: "User feedback is reflected only in the summary for mock mode."
        }),
        toolCalls: [],
        usage: {
          inputTokens: estimateTokens(input),
          outputTokens: 80,
          totalTokens: estimateTokens(input) + 80
        }
      };
    }

    if (!lastToolNames.includes("write_file")) {
      return this.response("Writing a runnable Node artifact.", [
        {
          id: "mock_write",
          name: "write_file",
          arguments: {
            path: "haiku.js",
            content: [
              "const lines = [",
              "  'Sandbox moonlight glows',",
              "  'Models shape quiet code paths',",
              "  'Tests bloom in warm sand'",
              "];",
              "console.log(lines.join('\\n'));",
              ""
            ].join("\n")
          }
        },
        {
          id: "mock_package",
          name: "write_file",
          arguments: {
            path: "package.json",
            content: JSON.stringify({ scripts: { start: "node haiku.js" } }, null, 2)
          }
        }
      ]);
    }

    if (!lastToolNames.includes("run_command")) {
      return this.response("Running the artifact.", [
        {
          id: "mock_run",
          name: "run_command",
          arguments: {
            command: "npm",
            args: ["start"]
          }
        }
      ]);
    }

    return this.response("The mock artifact is complete.", [
      {
        id: "mock_finish",
        name: "finish",
        arguments: {
          summary: "Created a runnable Node.js haiku program and verified it with npm start.",
          instructions: "Run npm start inside the artifact workspace.",
          artifacts: ["haiku.js", "package.json"]
        }
      }
    ]);
  }

  private response(content: string, toolCalls: ModelResponse["toolCalls"]): ModelResponse {
    return {
      content,
      toolCalls,
      usage: {
        inputTokens: 20,
        outputTokens: 20,
        totalTokens: 40
      }
    };
  }
}
