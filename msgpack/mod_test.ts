/**
The MIT License (MIT)

Copyright (c) 2023 Bernd Amend <typescript@berndamend.de>

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/
import { assertEquals } from "https://deno.land/std@0.196.0/assert/mod.ts";
import { deserialize, Serializer } from "./mod.ts";
import { toHexString } from "../helper/mod.ts";

Deno.test(function serializeTest() {
  const s = new Serializer();

  // deno-lint-ignore no-explicit-any
  const doit = (input: any, expected?: string, expectedOutput?: any) => {
    s.reset();
    s.add(input);
    const r = s.getBufferView();
    if (expected !== undefined) {
      assertEquals(toHexString(r), expected);
    }
    assertEquals(deserialize(r), expectedOutput ?? input);
  };

  doit(true, "c3");
  doit(false, "c2");
  doit({ 0: null }, "81a130c0", { 0: undefined });
  doit(42, "2a", 42);
  doit(42n, "2a", 42);
  doit(34244n, "cd85c4", 34244);
  doit(2 ** 15 - 1, "cd7fff");
  doit(2 ** 30 - 1, "ce3fffffff");
  doit(2 ** 45 - 1, "cf00001fffffffffff");
  doit(2 ** 53 - 1, "cf001fffffffffffff");
  doit(2n ** 53n - 1n, "cf001fffffffffffff", 2 ** 53 - 1);
  doit(2n ** 54n - 1n, "cf003fffffffffffff");
  doit(2n ** 62n - 1n, "cf3fffffffffffffff");
  doit(-12, "f4", -12);
  doit(-12n, "f4", -12);
  doit(-34244n, "d2ffff7a3c", -34244);
  doit(-(2 ** 15 - 1), "d18001");
  doit(-(2 ** 30 - 1), "d2c0000001");
  doit(-(2 ** 45 - 1), "d3ffffe00000000001");
  doit(-(2 ** 53 - 1), "d3ffe0000000000001");
  doit(-(2n ** 53n - 1n), "d3ffe0000000000001", -(2 ** 53 - 1));
  doit(-(2n ** 56n - 3n), "d3ff00000000000003");
  doit(-(2n ** 62n - 3n), "d3c000000000000003");
  doit(
    "test string with äüößêú ù KKS§$%&/(89898908902839489028349890yxcvbndfhg\"'",
    "d9517465737420737472696e67207769746820c3a4c3bcc3b6c39fc3aac3ba20c3b9204b4b53c2a72425262f28383938393839303839303238333934383930323833343938393079786376626e646668672227",
  );
  doit(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, "hallo"],
    "9f0102030405060708090a0b0c0d0ea568616c6c6f",
  );
  doit(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, "hallo", "welt?", [
      1,
      2,
      3,
      4,
      5,
      [1, 2, 3, 4, 5, [1, 2, 3, 4, 5, 6, [1, 2, 3, 4, 5, 6]]],
    ]],
    "dc00120102030405060708090a0b0c0d0e0fa568616c6c6fa577656c743f9601020304059601020304059701020304050696010203040506",
  );
  doit({ "foo": "bar" }, "81a3666f6fa3626172");
  doit(Date.now());

  doit(
    {
      "fisch": "hallo",
      "oh": 42,
      "bla": [1, 2, 3, 4, 5, 6],
      "44": { "1": 2, "3": 4 },
      "99": 12.44,
      "jein": 9383387773773,
    },
    "86a2343482a13102a13304a23939cb4028e147ae147ae1a56669736368a568616c6c6fa26f682aa3626c6196010203040506a46a65696ecf00000888bd7ebb4d",
  );

  doit(
    {
      "fisch": "hallo",
      "oh": 42,
      "bla": [
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8,
        9,
        10,
        "hallo",
        99,
        "Übung",
        2n ** 62n - 1n,
        2n ** 55n - 7n,
        [
          1,
          [2, 3, 4, 5, 6, 7, 8, 9, 10],
          3,
          4,
          5,
          6,
          7,
          8,
          9,
          10,
        ],
        "hallo",
        undefined,
        "???",
        42,
      ],
      44: { 1: 2, 3: 4 },
      99: 12.44,
      "jein": 938338777332233773n,
      "wie": undefined,
      "wie2": undefined,
    },
    "88a2343482a13102a13304a23939cb4028e147ae147ae1a56669736368a568616c6c6fa26f682aa3626c61dc00140102030405060708090aa568616c6c6f63a6c39c62756e67cf3fffffffffffffffcf007ffffffffffff99a019902030405060708090a030405060708090aa568616c6c6fc0a33f3f3f2aa46a65696ecf0d05a6257ddcb62da3776965c0a477696532c0",
  );
});
