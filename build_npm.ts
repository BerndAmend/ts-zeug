// Copyright 2023-2024 Bernd Amend. MIT license.
import { build, emptyDir } from "https://deno.land/x/dnt@0.39.0/mod.ts";

await emptyDir("./npm");

await build({
  entryPoints: ["./mod.ts"],
  outDir: "./npm",
  compilerOptions: {
    target: "Latest",
    lib: ["ESNext", "DOM"],
  },
  shims: {
    deno: "dev",
  },
  typeCheck: false,
  test: false,
  declaration: "inline",
  esModule: true,
  scriptModule: false,
  package: {
    name: "ts-zeug",
    version: Deno.args[0],
    description: "Various stuff/zeug for typescript for deno, node and the web",
    license: "MIT",
    repository: {
      type: "git",
      url: "https://github.com/BerndAmend/ts-zeug.git",
    },
    bugs: {
      url: "https://github.com/BerndAmend/ts-zeug/issues",
    },
  },
  postBuild() {
    Deno.copyFileSync("LICENSE", "npm/LICENSE");
    Deno.copyFileSync("README.md", "npm/README.md");
  },
});
