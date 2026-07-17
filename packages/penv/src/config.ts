/**
 * `import "@penvhq/penv/config"` — the dotenv-shaped compatibility entry, under the
 * specifier users install.
 *
 * A bare side-effect import, because that is the whole contract: evaluating this
 * module populates `process.env`. It carries `@penvhq/runtime/config`'s ESM
 * ordering caveat unchanged — a sibling module imported above this one that
 * reads `process.env` at its top level reads it before penv has populated it.
 * The typed `import { env } from "@env"` surface has no such hazard.
 */

import "@penvhq/runtime/config";
