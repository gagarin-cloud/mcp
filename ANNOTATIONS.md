# Tool annotations, and why

Every tool sets all four hints explicitly to `true` or `false`; none is left to
the protocol's defaults. The rules they follow, with no exceptions:

- **readOnly** — the call changes nothing at all. A read that also records
  something (memory search ranking, link strength) is not read-only.
- **destructive** — the call replaces state, or takes away state or somebody's
  access to it, even when another call could put it back. A hint covers the
  call's worst case, so a tool is destructive if any of its arguments make it so.
  Whether a human is also asked is separate: the tools marked † answer
  `approval_required` and email the account owner a button first.
- **idempotent** — calling it again with the same arguments has no further effect.
- **openWorld** — the call reaches past the caller's own Gagarin account: it puts
  something on the public internet or before other accounts, or takes in what
  another account published. Everything else acts inside one account.

No tool takes or returns a secret (a password, API key or token). Those are
handled by the account holder with the `gg` CLI, from a file.

`tools.test.ts` checks this table against what the server advertises, so the
two cannot drift.

| Tool | readOnly | destructive | idempotent | openWorld | Why |
| --- | --- | --- | --- | --- | --- |
| `add_domain` | false | false | true | true | Gives a service a public HTTPS address (DNS and a certificate authority); takes nothing away, and asking twice gives the same address. |
| `add_resource` | false | true | true | false | Creates a database, cache or bucket; called on one that exists it resizes it or replaces its extension set, so it can replace state. |
| `alerts` | true | false | true | false | Reads the caller's alert opt-in and recent notifications. |
| `alerts_off` | false | false | true | false | Records only the caller's own preference not to be notified; no data or access is lost, and the console switch turns it back on. |
| `backup_resource` | false | false | false | false | Takes a new backup alongside the existing ones; each call makes another. |
| `backups` | true | false | true | false | Lists a resource's backups. |
| `billing` | true | false | true | false | Reads balance, burn rate and runway. |
| `billing_history` | true | false | true | false | Reads the ledger rows the balance is made from. |
| `create_project` | false | false | false | false | Creates a new, empty project; each call makes another. |
| `credentials` | true | false | true | false | Lists the account's credentials by label, scope and dates — never a secret. |
| `deploy` | false | true | true | false | Replaces what a service runs: its image and its whole environment. |
| `deps` | true | false | true | false | Reads which services and resources may reach which. |
| `destroy_project` | false | true | true | false | † Deletes a project and everything in it. |
| `destroy_resource` | false | true | true | false | † Deletes a resource and its data. |
| `destroy_service` | false | true | true | false | † Deletes a service, its volume and its address. |
| `eject` | true | false | true | false | Exports a project's manifests for reading. |
| `history` | true | false | true | false | Reads a service's deploy history (variable names, never values). |
| `install_recipe` | false | false | true | true | Fills a new, empty project from a recipe another account published; replaces nothing. |
| `logs` | true | false | true | false | Reads what a service or job printed. |
| `members` | true | false | true | false | Lists who a project is shared with, by the email `share` and `unshare` take. |
| `memory_briefing` | true | false | true | false | Reads the project memory's briefing; records nothing. |
| `memory_get` | false | false | false | false | Reading memories in full counts toward their ranking, so it writes as it reads. |
| `memory_link` | false | true | true | false | Links memories; restating a link replaces its note. |
| `memory_related` | false | false | false | false | Following links strengthens them, so it writes as it reads. |
| `memory_review` | true | false | true | false | Reads memories due for review; records nothing. |
| `memory_search` | false | false | false | false | What a search returns counts toward ranking, so it writes as it reads. |
| `memory_unlink` | false | true | true | false | Removes a link between memories. |
| `memory_update` | false | true | true | false | Overwrites a memory's fields, or archives it. |
| `platform_health` | true | false | true | false | Reads Gagarin's own status. |
| `projects` | true | false | true | false | Lists the caller's projects. |
| `publish_resource` | false | true | true | true | Makes a bucket readable by anyone on the internet, which cannot be recalled. |
| `recipe` | true | false | true | true | Reads a recipe another account published. |
| `recipe_diff` | true | false | true | true | Compares a project against a newer version of another account's recipe. |
| `recipe_install` | true | false | true | false | Reads how a recipe install stands. |
| `recipes` | true | false | true | false | Lists the caller's own recipes. |
| `referrals` | true | false | true | false | Reads the caller's invite link and earnings; signups are never named. |
| `remember` | false | true | false | false | Saves a memory, and with `supersedes` replaces an existing one; each call makes another. |
| `remove_domain` | false | true | true | true | † Takes a public address off the internet. |
| `remove_recipe` | false | true | true | true | † Withdraws a published recipe from every other account. |
| `resource_keys` | true | false | true | false | Lists the variable names a resource publishes — never their values. |
| `restore_resource` | false | false | false | false | Restores a backup into a new resource; never overwrites one that exists. |
| `revoke_credential` | false | true | true | false | Stops a credential working immediately. |
| `rollback` | false | true | true | false | Replaces what a service runs with an earlier revision. |
| `rotate_resource` | false | true | false | false | Gagarin mints new credentials for a database or bucket and the old ones stop working; the new ones are never returned. |
| `run` | false | false | false | false | Starts a new run of a one-off job; each call starts another. |
| `set_alerts` | false | false | true | false | Records only the caller's own opt-in to notifications; nothing is lost. |
| `set_deps` | false | true | true | false | † Replaces a service's dependency set; dropping an edge cuts a connection. |
| `share` | false | true | true | false | Grants a role on a project, or changes the role somebody already has. |
| `snap_recipe` | false | false | false | true | Publishes a new version of a project as a recipe other accounts can install; adds a version and replaces nothing. |
| `status` | true | false | true | false | Reads what a project runs and whether it is up. |
| `test_alerts` | false | false | false | false | Sends one notification to the caller's own devices. |
| `transfer` | false | true | true | false | † Offers the project's ownership to another member. |
| `unpublish_resource` | false | true | true | true | Takes a public bucket off the internet. |
| `unshare` | false | true | true | false | Removes somebody's access to a project. |
| `untransfer` | false | true | true | false | Withdraws an ownership offer somebody may be about to accept. |
| `update_recipe` | false | true | false | true | † Moves a project to a newer version of another account's recipe, replacing or removing what it changes. |
| `whoami` | true | false | true | false | Reads whether there is a credential and what it may do — never the caller's email. |
