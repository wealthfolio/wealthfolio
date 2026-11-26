-- Payees: a fourth activity-scoped taxonomy, beside spending categories,
-- income sources and savings. A cash activity is filed under at most one
-- payee (who the money went to or came from), independently of its category,
-- in the existing activity_taxonomy_assignments table.
--
-- It starts empty: payees are created by the user.
INSERT INTO taxonomies (id, name, color, description, is_system, is_single_select, sort_order, scope)
VALUES
  ('payees', 'Payees', '#5B7C99',
   'Who a cash activity was paid to or received from. One per activity, independent of its category.',
   1, 1, 230, 'activity');
