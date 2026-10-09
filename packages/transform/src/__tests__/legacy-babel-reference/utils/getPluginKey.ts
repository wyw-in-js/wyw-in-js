type PluginItemLike =
  | string
  | readonly [PluginItemLike, ...unknown[]]
  | { key?: string | null }
  | object
  | null
  | undefined;

export const getPluginKey = (plugin: PluginItemLike): string | null => {
  if (typeof plugin === 'string') {
    return plugin;
  }

  if (Array.isArray(plugin)) {
    return getPluginKey(plugin[0]);
  }

  if (typeof plugin === 'object' && plugin !== null && 'key' in plugin) {
    return (plugin as { key?: string | null }).key ?? null;
  }

  return null;
};
