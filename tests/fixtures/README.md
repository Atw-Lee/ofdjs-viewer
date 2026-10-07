# Seal appearance fixture

`seal-appearances.ofd` is original synthetic test data, generated entirely with
Node.js and the repository's existing `fflate` dependency. It contains a clipped
PNG ring and a nested OFD appearance over a green page. Transparent areas expose
the underlying page. SES v4/2020 envelopes use dummy certificates and signatures;
the fixture tests appearance rendering, not signature verification.

Regenerate from the repository root:

```sh
node tests/fixtures/generate-seals.mjs
node tests/fixtures/generate-seals.mjs --check
```

ZIP timestamps are fixed. Commit the generator and regenerated fixture together.
The browser tests cover both appearances at two scales and late image cleanup
after cancellation and document disposal, malformed metadata and picture data,
and page-specific stamp placement.
