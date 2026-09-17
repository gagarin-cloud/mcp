/*
  The annotations of every tool, as the protocol reports them.

  This is a snapshot and nothing else: no rule lives here, and reading it to
  learn what a tool is would be reading the copy rather than the original. Its
  whole job is to make a change loud. A tool added without annotations, or one
  whose classification is edited in passing, fails `npm test` with a diff naming
  the tool — which is the only way a client's "do I ask a human first?" decision
  gets reviewed by a person rather than inherited from a default.

  Regenerate it deliberately, never to make a red test go green, and say in the
  commit message why the classification changed.

    [title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint]
*/

export type SnapshotRow = readonly [string, boolean, boolean, boolean, boolean];

export const TOOLS_SNAPSHOT: Readonly<Record<string, SnapshotRow>> = {
  add_domain: ['Add domain', false, false, true, false],
  add_resource: ['Add resource', false, false, true, false],
  backup_resource: ['Back up resource', false, false, false, false],
  backups: ['List backups', true, false, true, false],
  billing: ['Show billing', true, false, true, false],
  billing_history: ['Show billing history', true, false, true, false],
  create_credential: ['Create credential', false, false, false, false],
  create_project: ['Create project', false, false, false, false],
  credentials: ['List credentials', true, false, true, false],
  deploy: ['Deploy service', false, false, true, false],
  deps: ['Show dependencies', true, false, true, false],
  destroy_project: ['Destroy project', false, true, true, false],
  destroy_resource: ['Destroy resource', false, true, true, false],
  destroy_service: ['Destroy service', false, true, true, false],
  eject: ['Export project manifests', true, false, true, false],
  history: ['Show deploy history', true, false, true, false],
  logs: ['Show logs', true, false, true, false],
  members: ['List project members', true, false, true, false],
  platform_health: ['Check platform health', true, false, true, false],
  projects: ['List projects', true, false, true, false],
  remove_domain: ['Remove domain', false, true, true, false],
  resource_keys: ['List resource keys', true, false, true, false],
  resource_secrets: ['Show resource secrets', true, false, true, false],
  restore_resource: ['Restore backup into a new resource', false, false, false, false],
  revoke_credential: ['Revoke credential', false, true, true, false],
  rollback: ['Roll back to a revision', false, false, true, false],
  rotate_resource: ['Rotate resource credentials', false, true, false, false],
  run: ['Run job', false, false, false, false],
  set_deps: ['Set dependencies', false, true, true, false],
  share: ['Share project', false, false, true, false],
  status: ['Show project status', true, false, true, false],
  transfer: ['Transfer project ownership', false, true, true, false],
  unshare: ['Unshare project', false, false, true, false],
  untransfer: ['Withdraw ownership offer', false, false, true, false],
  whoami: ['Show current account', true, false, true, false],
};
