-- Assignments and categories go with the taxonomy (ON DELETE CASCADE), but
-- delete them explicitly so this does not depend on foreign keys being on.
DELETE FROM activity_taxonomy_assignments WHERE taxonomy_id = 'payees';
DELETE FROM taxonomy_categories WHERE taxonomy_id = 'payees';
DELETE FROM taxonomies WHERE id = 'payees';
