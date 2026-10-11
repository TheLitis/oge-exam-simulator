# XML parser used for Office document inspection

The application vendors Saxes 6.0.0 and the three character tables it uses from
xmlchars 2.2.0. Sources were downloaded from the official npm registry, and each
tarball's SHA-512 integrity was verified against registry metadata.

- Saxes: https://registry.npmjs.org/saxes/-/saxes-6.0.0.tgz
  - SHA-256: `1cdf52fbbe1ccbd175c365d2b8e63f46e590e74aff23fa6a44a6ec51522e96db`
  - SHA-512: `xAg7SOnEhrm5zI3puOOKyy1OMcMlIJZYNJY7xLBwSze0UjhPLnWfj2GF2EpT0jmzaJKIWKHLsaSSajf35bcYnA==`
  - Upstream: https://github.com/lddubeau/saxes/tree/v6.0.0
  - License: `Saxes-LICENSE.txt` (ISC), copied from the versioned upstream tag,
    because the npm tarball omits its license file.
- xmlchars: https://registry.npmjs.org/xmlchars/-/xmlchars-2.2.0.tgz
  - SHA-256: `bdf900298963e4bd95b76aa95e96d29f05687e6ae662d617061778267b576da8`
  - SHA-512: `JZnDKK8B0RCDw84FNdDAIpZK+JuJw+s7Lz8nksI7SIuU3UXJJslUthsi+uWBUYOwPFwW7W7PRLRfUKpxjtjFCw==`
  - License: `xmlchars/LICENSE` (MIT).

`saxes.cjs` differs from the published JavaScript only in the three require paths
(changed to local `./xmlchars/...` paths) and its filename/newline encoding.
The character tables are unmodified; source maps and unused tables are omitted.

Format references:

- ODF 1.3 package specification:
  https://docs.oasis-open.org/office/OpenDocument/v1.3/os/part2-packages/OpenDocument-v1.3-os-part2-packages.html
- ODF 1.3 document schema:
  https://docs.oasis-open.org/office/OpenDocument/v1.3/os/part3-schema/OpenDocument-v1.3-os-part3-schema.pdf
- SpreadsheetML sheets:
  https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/working-with-sheets
- PresentationML package structure:
  https://learn.microsoft.com/en-us/office/open-xml/presentation/structure-of-a-presentationml-document

Inspection is read-only. The application rejects DTDs, custom entities, macros,
encrypted packages and unsafe ZIP paths; it never resolves external references
or evaluates spreadsheet formulas.
