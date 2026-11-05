Reviewed license texts for bundled packages whose installed copy ships no license file. `build.mjs` uses a file here
(named after the package, with `/` as `__`) only when the package has none of its own, and fails when neither exists,
so a new dependency can't ship without its notice. Each text comes from the package's upstream repository.
