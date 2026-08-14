# Registry entries

Each plugin has one JSON file named after its Agent Plugins manifest name. The entry points to a
public GitHub repository, a full immutable commit SHA, and an optional plugin subdirectory.

Do not add hand-written entries unless the generator cannot represent a valid package:

```bash
npm run add -- https://github.com/<owner>/<repository>
```

The JSON Schema is [`../schemas/registry-entry.schema.json`](../schemas/registry-entry.schema.json).
An empty registry is valid; the first community plugins should enter through reviewed pull requests.
