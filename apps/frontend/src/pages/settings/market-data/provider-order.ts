interface RankedProvider {
  id: string;
  priority: number;
}

/**
 * The priority updates that move one provider a step up (-1) or down (1) the
 * fetch order. Lower priorities are tried first.
 *
 * The two providers trade places and the positions keep their priorities, so a
 * move normally changes two rows. Providers that share a priority have no
 * defined order, so later ones are raised until each position has its own.
 */
export function moveProvider(
  ordered: RankedProvider[],
  index: number,
  step: -1 | 1,
): RankedProvider[] {
  const target = index + step;
  if (index < 0 || index >= ordered.length || target < 0 || target >= ordered.length) {
    return [];
  }

  const order = [...ordered];
  [order[index], order[target]] = [order[target], order[index]];

  const changes: RankedProvider[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  order.forEach((provider, position) => {
    const priority = Math.max(ordered[position].priority, previous + 1);
    previous = priority;
    if (priority !== provider.priority) {
      changes.push({ id: provider.id, priority });
    }
  });
  return changes;
}
