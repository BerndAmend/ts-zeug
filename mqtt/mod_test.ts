/**
 * Copyright 2025 Bernd Amend. MIT license.
 */
import { assertEquals, assertThrows } from "@std/assert";
import * as m from "./mod.ts";

// asTopic
Deno.test("asTopic: valid topics", () => {
  m.asTopic("foo");
  m.asTopic("foo/bar");
  m.asTopic("foo/bar/baz");
  m.asTopic("foo-bar_123");
  m.asTopic("ä/ö/ü/&");
});

Deno.test("asTopic: invalid topics", () => {
  const invalid = [
    "",
    "/foo",
    "#",
    "foo/#",
    "foo/bar#",
    "foo/#/bar",
    "foo/+/bar",
    "+/foo/bar",
    "foo/bar+",
    "foo/bar/#",
    "foo/bar/#/baz",
    "foo/bar/+/baz",
    "foo/bar+foo",
    "foo/bar#foo",
  ];
  for (const t of invalid) {
    assertThrows(() => m.asTopic(t));
  }
});
