import { defineConfig } from "orval";

export default defineConfig({
  greader: {
    input: "./openapi/greader.yaml",
    output: {
      target: "./src/generated/greader.ts",
      client: "fetch",
      mode: "single",
      override: {
        mutator: { path: "./src/http.ts", name: "customFetch" },
      },
    },
  },
});
