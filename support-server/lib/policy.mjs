// Phase3 MVP policy

export const DISALLOWED_ACTIONS = new Set([
  'instance.terminate',
  'instance.stop',
  'instance.reimage',
  'dns.delete_zone',
  'dns.delete_ns',
]);

export const ACTION_LEVEL = {
  // L0 (read)
  'dnspod.describe_domain_list': 'L0',
  'dnspod.describe_record_list': 'L0',
  // L1 (reversible write)
  'dnspod.upsert_record': 'L1',
};

export function isAllowedAction(type){
  if (DISALLOWED_ACTIONS.has(type)) return false;
  return Boolean(ACTION_LEVEL[type]);
}
