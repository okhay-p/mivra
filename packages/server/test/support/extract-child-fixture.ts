/**
 * Stand-ins for the extraction subprocess's entry, for testing how the parent handles a child that
 * misbehaves. The behaviour comes from the first argument.
 */
const behaviour = process.argv[2];

if (behaviour === "ignore-sigterm") process.on("SIGTERM", () => {});

process.once("message", () => {
  switch (behaviour) {
    case "crash":
      process.abort();
      break;
    case "ignore-sigterm":
      setInterval(() => {}, 1000);
      // Tells the test it's ignoring SIGTERM, without a message the parent would reject.
      process.stderr.write("ready\n");
      break;
    case "malformed":
      process.send!({ ok: true, document: { kind: "exe", pages: "lots" } });
      setInterval(() => {}, 1000);
      break;
    case "allocate": {
      // Memory outside the JavaScript heap, as a decompression bomb's decoded streams are.
      const held: Buffer[] = [];
      setInterval(() => held.push(Buffer.alloc(32 * 1024 * 1024, 1)), 10);
      break;
    }
    case "heap": {
      const held: string[][] = [];
      for (;;) held.push(Array.from({ length: 100_000 }, (_, i) => `entry ${i} ${held.length}`));
    }
  }
});
