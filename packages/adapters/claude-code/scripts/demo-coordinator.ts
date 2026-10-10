// Local coordinator for scripts/demo-firm-claim.sh: the protocol's ReferenceCoordinator behind
// the same HTTP binding the adapter tests use. Bundled to dist/demo-coordinator.mjs by build.mjs.
import { ReferenceCoordinator } from "@weft/protocol";
import { serve } from "../test/helpers";

const { url } = await serve(new ReferenceCoordinator({ repo: "demo" }));
process.stdout.write(`listening ${url}\n`);
