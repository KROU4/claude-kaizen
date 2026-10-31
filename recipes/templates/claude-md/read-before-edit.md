## Editing files

- Read a file immediately before editing it. Never edit from memory of an earlier read if any command, formatter or hook may have changed the file since.
- After a shell command that can rewrite files (formatters, codegen, git checkout/stash/merge, package installs), re-read the files you are about to touch.
- Prefer several small, exact edits over one large replacement. Copy the `old_string` verbatim from the latest read, including whitespace.
- If an edit fails because the text was not found, re-read the file and look for what changed instead of retrying the same edit.
