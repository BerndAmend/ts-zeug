/**
 * Copyright 2023-2025 Bernd Amend. MIT license.
 */
import { assertEquals } from "jsr:@std/assert@^1.0.11";
import { deserialize, Serializer } from "./mod.ts";
import { toHexString } from "../helper/mod.ts";

Deno.test(function serializeTest() {
  const s = new Serializer();

  const doit = (
    input: unknown,
    expected?: string,
    expectedOutput?: unknown,
  ) => {
    s.reset();
    s.add(input);
    const r = s.getBufferView();
    if (expected !== undefined) {
      assertEquals(toHexString(r), expected);
    }
    assertEquals(deserialize(r)[0], expectedOutput ?? input);
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
  doit(new Date());

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

  doit(
    {
      0: 1704873107862761,
      1: 7,
    },
    "82a130cf00060e92b3fb34e9a13107",
  );

  doit(
    {
      0: 1234567890,
      1: {
        0: {
          0: {
            9: "hihihihihihihihihihihihihihihihihihihi",
            10: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 0]),
          },
          "bla": "123456789012345678901234567890",
        },
        "nein": "123456789012345678901234567890",
      },
      "äß": new Uint8Array([
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8,
        9,
        0,
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8,
        9,
        0,
      ]),
      "something": "123456789012345678901234567890",
    },
    "84a130ce499602d2a13182a13082a13082a139d9266869686968696869686968696869686968696869686968696869686968696869686968696869a23130c40a01020304050607080900a3626c61be313233343536373839303132333435363738393031323334353637383930a46e65696ebe313233343536373839303132333435363738393031323334353637383930a4c3a4c39fc4140102030405060708090001020304050607080900a9736f6d657468696e67be313233343536373839303132333435363738393031323334353637383930",
  );
});
