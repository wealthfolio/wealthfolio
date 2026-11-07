-- Removing a category cascades to any asset assigned to it, which is the state
-- those assets were in before the up migration: no region at all.
DELETE FROM taxonomy_categories
WHERE taxonomy_id = 'regions'
  AND id IN (
    'country_AX', 'country_FO', 'country_GG', 'country_IM', 'country_JE', 'country_SJ',
    'country_MD', 'country_MK', 'country_SI', 'country_BQ', 'country_CW', 'country_BV',
    'country_GS', 'country_PS', 'country_EH', 'country_CI', 'country_CX', 'country_CC',
    'country_HM', 'country_SB', 'country_UM'
  );
