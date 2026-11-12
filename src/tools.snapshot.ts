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
  add_domain: ['Add domain', false, false, true, true],
  add_resource: ['Add resource', false, true, true, false],
  alerts: ['Show project alerts', true, false, true, false],
  alerts_off: ['Turn off project alerts', false, true, true, false],
  backup_resource: ['Back up resource', false, false, false, false],
  backups: ['List backups', true, false, true, false],
  billing: ['Show billing', true, false, true, false],
  billing_history: ['Show billing history', true, false, true, false],
  create_project: ['Create project', false, false, false, false],
  credentials: ['List credentials', true, false, true, false],
  deploy: ['Deploy service', false, true, true, false],
  deps: ['Show dependencies', true, false, true, false],
  destroy_project: ['Destroy project', false, true, true, false],
  destroy_resource: ['Destroy resource', false, true, true, false],
  destroy_service: ['Destroy service', false, true, true, false],
  history: ['Show deploy history', true, false, true, false],
  install_recipe: ['Install recipe', false, false, true, true],
  logs: ['Show logs', true, false, true, false],
  members: ['List project members', true, false, true, false],
  memory_briefing: ['Read project briefing', true, false, true, false],
  memory_get: ['Read memories in full', false, false, false, false],
  memory_link: ['Link memories', false, true, true, false],
  memory_related: ['Follow memory links', false, false, false, false],
  memory_review: ['Review project memory', true, false, true, false],
  memory_search: ['Search project memory', false, false, false, false],
  memory_unlink: ['Unlink memories', false, true, true, false],
  memory_update: ['Update a memory', false, true, true, false],
  platform_health: ['Check platform health', true, false, true, false],
  projects: ['List projects', true, false, true, false],
  publish_resource: ['Make bucket public', false, true, true, true],
  recipe: ['Show recipe', true, false, true, true],
  recipe_diff: ['Diff recipe update', true, false, true, true],
  recipe_install: ['Show recipe install', true, false, true, false],
  recipes: ['List my recipes', true, false, true, false],
  referrals: ['Show referrals', true, false, true, false],
  remember: ['Save a memory', false, true, false, false],
  remove_domain: ['Remove domain', false, true, true, true],
  remove_recipe: ['Remove recipe', false, true, true, true],
  resource_keys: ['List resource keys', true, false, true, false],
  restore_resource: ['Restore backup into a new resource', false, false, true, false],
  revoke_credential: ['Revoke credential', false, true, true, false],
  rollback: ['Roll back to a revision', false, true, true, false],
  rotate_resource: ['Rotate resource credentials', false, true, false, false],
  run: ['Run job', false, true, false, false],
  set_alerts: ['Set project alerts', false, false, true, false],
  set_deps: ['Set dependencies', false, true, true, false],
  share: ['Share project', false, true, true, false],
  snap_recipe: ['Publish project as recipe', false, false, false, true],
  status: ['Show project status', true, false, true, false],
  test_alerts: ['Send a test alert', false, false, false, false],
  transfer: ['Transfer project ownership', false, true, true, false],
  unpublish_resource: ['Make bucket private', false, true, true, true],
  unshare: ['Unshare project', false, true, true, false],
  untransfer: ['Withdraw ownership offer', false, true, true, false],
  update_recipe: ['Update recipe', false, true, false, true],
  whoami: ['Show current account', true, false, true, false],
};
