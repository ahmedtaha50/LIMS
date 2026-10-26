// The operations of /api/v1, one module per area. Importing a module registers its operations (defineRoute); the list is explicit
// because the production server is one esbuild bundle. The order here is the order of the OpenAPI document.
import './samples';
import './results';
import './quality';
