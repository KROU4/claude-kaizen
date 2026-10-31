# Demo app project notes

Synthetic instructions used by the Kaizen fixtures. Nothing in this file is real.

## Voice

- Always answer in English.
- Keep explanations short and concrete.
- Prefer plain words over jargon.

## Layout

- The src directory holds the application modules.
- The scripts directory holds small helper programs.
- The docs directory holds the long form notes.
- The config directory holds one file per environment.
- The assets directory holds static images.
- The dist directory is generated and never kept in the repository.
- The tmp directory is scratch space and can be deleted at any time.
- Each module keeps its public surface in a single index file.
- Shared helpers live next to the module that uses them first.

## Modules

- The loader module reads the settings and exposes a frozen object.
- The router module maps paths to handlers and nothing else.
- The store module wraps the database client behind three functions.
- The queue module retries failed jobs with a capped backoff.
- The mailer module renders templates and hands them to the transport.
- The metrics module counts events and flushes them every minute.
- The cache module keeps values for a short time and evicts the oldest first.
- The auth module issues short lived sessions and rotates them often.
- The cli module parses flags and calls the same functions as the server.

## Config

- Every setting has a default that works on a laptop.
- Environment names are lowercase words such as local, staging and prod.
- Secrets come from the environment and never appear in the files.
- Numeric settings carry their unit in the name, for example timeoutMs.
- Boolean settings read as questions, for example isEnabled.
- Unknown keys are reported at start up and then ignored.
- Settings files are plain JSON without comments.
- Changing a default requires a note in the changelog.
- Overrides are applied in a fixed order: defaults, file, environment.

## Build

- The build step bundles the sources into the dist directory.
- A clean build removes dist before it starts.
- Source maps are generated for every bundle.
- The build prints one line per bundle with its size.
- Warnings are collected and printed once at the end.
- A failed build leaves the previous dist directory untouched.
- The version string is injected at build time from the package file.
- Build output is deterministic for identical inputs.
- Build scripts avoid network access.

## Deploy

- The service is packaged into one archive per release.
- Staging receives every release first.
- Production receives a release after a day without alerts.
- Rollbacks reuse the previous archive and take under a minute.
- Release notes are generated from the changelog.
- Database changes ship as separate numbered steps.
- Every step can run twice without harm.
- The deploy script prints the target before it starts.
- A deploy never changes settings that belong to another environment.

## Logging

- Logs are single line JSON records.
- Each record carries a level, a time and a short message.
- Request records add the path, the status and the duration.
- Errors add a code and a short hint for the reader.
- Personal data never appears in the logs.
- Debug records are off by default and cheap when off.
- Log files rotate daily and are kept for two weeks.
- Noisy records are sampled instead of removed.
- The logger is created once and passed down explicitly.

## Naming

- Files use lowercase words joined by hyphens.
- Functions use verbs and return the thing they name.
- Constants use upper case words joined by underscores.
- Types use singular nouns.
- Abbreviations are avoided unless everyone knows them.
- A name that needs a comment is renamed instead.
- Private helpers start with an underscore.
- Plural names hold lists and singular names hold one item.
- Names describe purpose rather than shape.

## Docs

- Each module has a short description at the top of its index file.
- Examples are preferred over long explanations.
- Diagrams are kept as text so they can be diffed.
- Docs describe the current behaviour and nothing planned.
- Links use relative paths so they survive moves.
- The changelog lists user visible changes only.
- Terms are defined once in the glossary.
- Screenshots are avoided because they age quickly.
- Open questions live in the docs directory under questions.

## Housekeeping

- Unused files are deleted rather than commented out.
- Dependencies are reviewed twice a year.
- Dead settings are removed together with their code.
- Temporary workarounds carry a date and an owner.
- Scripts that nobody ran for a year are archived.
- Generated files are listed in the ignore file.
- Large binary files are kept out of the repository.
- Branch names describe the change in a few words.
- Old branches are removed after they are merged.
- Rarely used flags are documented next to the code that checks them.

End of the synthetic notes.
