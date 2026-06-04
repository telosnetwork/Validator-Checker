const fs = require("node:fs/promises");
const path = require("node:path");
const { evaluateReadiness } = require("../ifchecker-api");

async function main() {
  const [testnet, mainnet] = await Promise.all([
    evaluateReadiness("testnet"),
    evaluateReadiness("mainnet")
  ]);
  const snapshot = {
    generatedAt: new Date().toISOString(),
    networks: {
      testnet,
      mainnet
    }
  };
  const outputDir = path.join(__dirname, "..", "validation", "ifchecker");
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, "latest.json"),
    `${JSON.stringify(snapshot, null, 2)}\n`
  );
  console.log(`IF checker snapshot: testnet ${testnet.counts.activeSpringCompatible}/${testnet.counts.scheduled}, mainnet ${mainnet.counts.activeSpringCompatible}/${mainnet.counts.scheduled}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
