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

// asTopicFilter
Deno.test("asTopicFilter: valid filters", () => {
  m.asTopicFilter("foo");
  m.asTopicFilter("foo/bar");
  m.asTopicFilter("foo/+");
  m.asTopicFilter("+/bar");
  m.asTopicFilter("+/+/baz");
  m.asTopicFilter("foo/+/baz");
  m.asTopicFilter("#");
  m.asTopicFilter("foo/#");
  m.asTopicFilter("foo/bar/#");
  m.asTopicFilter("+");
  m.asTopicFilter("ä/ö/ü/+");
});

Deno.test("asTopicFilter: invalid filters", () => {
  const invalid = [
    "", // empty string
    "/foo", // starts with /
    "foo/#/bar", // # not at the end
    "foo/#/#", // multiple #
    "foo/bar#", // # not alone in level
    "foo/ba+r", // + not alone in level
    "foo/+/bar+", // + not alone in level
    "foo/#/+", // # not at the end
    "foo/bar/#/baz", // # not at the end
    "foo/bar/#/+", // # not at the end
    "foo/bar+/#", // + not alone in level
    "foo/bar/#foo", // # not alone in level
    "foo/bar/fo#o", // # not alone in level
    "foo/bar/fo+o", // + not alone in level
  ];
  for (const f of invalid) {
    assertThrows(
      () => m.asTopicFilter(f),
    );
  }
});

