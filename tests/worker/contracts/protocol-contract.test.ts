import createSchema from "../../../protocol/v1/create-request.schema.json";
import errorSchema from "../../../protocol/v1/error.schema.json";
import manifestSchema from "../../../protocol/v1/manifest.schema.json";
import updateSchema from "../../../protocol/v1/update-request.schema.json";
import { protocolContract } from "../../contracts/protocol-contract";
import createFixture from "../../fixtures/protocol/v1/create.json";
import errorFixture from "../../fixtures/protocol/v1/error.json";
import manifestFixture from "../../fixtures/protocol/v1/manifest.json";
import updateFixture from "../../fixtures/protocol/v1/update.json";

protocolContract("Worker/CLI/Viewer shared", [
  { name: "create", fixture: createFixture, schema: createSchema },
  { name: "update", fixture: updateFixture, schema: updateSchema },
  { name: "manifest", fixture: manifestFixture, schema: manifestSchema },
  { name: "error", fixture: errorFixture, schema: errorSchema },
]);
