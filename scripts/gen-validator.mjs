// schema/gantt.schema.json から、Workers で動く (new Function を使わない) 検証関数を生成する。
// ajv の実行時コンパイルは Workers では使えないため、ビルド前に standalone コードを書き出す。
// 実行: pnpm gen:validator (スキーマを変更したら再生成。テストが最新かどうか確認する)。
import { readFileSync, writeFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone/index.js";

const root = new URL("../", import.meta.url);
const schema = JSON.parse(readFileSync(new URL("schema/gantt.schema.json", root), "utf8"));
export function generate() {
  const ajv = new Ajv2020({ allErrors: true, strict: false, code: { source: true, esm: true } });
  addFormats.default ? addFormats.default(ajv) : addFormats(ajv);
  const validate = ajv.compile(schema);
  let code = standaloneCode.default ? standaloneCode.default(ajv, validate) : standaloneCode(ajv, validate);
  code = code
    .replace('require("ajv-formats/dist/formats")', "__formats")
    .replace('require("ajv/dist/runtime/equal").default', "__equal")
    .replace('require("ajv/dist/runtime/equal")', "__equal")
    .replace('require("ajv/dist/runtime/ucs2length").default', "__ucs2length")
    .replace('require("ajv/dist/runtime/ucs2length")', "__ucs2length");
  if (/require\(/.test(code)) throw new Error("unexpected require() left in generated validator");
  return (
    "// 自動生成: scripts/gen-validator.mjs (pnpm gen:validator)。手で編集しない。\n" +
    'import * as __formats from "ajv-formats/dist/formats.js";\n' +
    'import * as __equalNs from "ajv/dist/runtime/equal.js";\n' +
    "const __equal = (__equalNs.default && __equalNs.default.default) || __equalNs.default || __equalNs;\n" +
    'import * as __ucs2Ns from "ajv/dist/runtime/ucs2length.js";\n' +
    "const __ucs2length = (__ucs2Ns.default && __ucs2Ns.default.default) || __ucs2Ns.default || __ucs2Ns;\n" +
    code +
    "\n"
  );
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  writeFileSync(new URL("src/worker/schedules/schemaValidator.generated.js", root), generate());
  console.log("wrote src/worker/schedules/schemaValidator.generated.js");
}
