// Copyright 2023-2024 Bernd Amend. MIT license.
import { build, emptyDir } from "https://deno.land/x/dnt@0.38.1/mod.ts";

await emptyDir("./npm");

await build({
  entryPoints: ["./mod.ts"],
  outDir: "./npm",
  shims: {
    deno: true,
    webSocket: true,
  },
  package: {
    name: "ts-zeug",
    version: Deno.args[0],
    description: "library for mqtt-ts, msgpack",
    license: "MIT",
    repository: {
      type: "git",
      url: "",
    },
    bugs: {
      url: "",
    },
  },
  postBuild() {
    Deno.copyFileSync("LICENSE", "npm/LICENSE");
    Deno.copyFileSync("README.md", "npm/README.md");
  },
});
