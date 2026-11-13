-- The regions seed carries 227 `country_*` nodes against ISO 3166-1's 249
-- assigned alpha-2 codes. A holding whose provider country is one of the missing
-- codes gets no region assignment at all, rather than a coarse one, so it counts
-- as unclassified in the geographic breakdown. Among the omissions are Slovenia,
-- and Jersey, Guernsey and the Isle of Man, which are common registered domiciles
-- for London-listed companies and investment trusts.
--
-- Each country goes under the sub-region UN M49 gives it, which is the grouping
-- the seed already follows (it places `TF` under Eastern Africa, as M49 does).
-- Antarctica (`AQ`) is the one ISO code left out: M49 assigns it no region, and
-- the seed has no node it belongs under.
--
-- `OR IGNORE` leaves a category alone if the user has already added one with
-- the same id. Sort orders continue each sub-region's existing sequence.

INSERT OR IGNORE INTO taxonomy_categories (id, taxonomy_id, parent_id, name, key, color, sort_order) VALUES
    -- Northern Europe
    ('country_AX', 'regions', 'R1010', 'Åland Islands',          'country_AX', '#c6dde8', 11),
    ('country_FO', 'regions', 'R1010', 'Faroe Islands',          'country_FO', '#abcfe2', 12),
    ('country_GG', 'regions', 'R1010', 'Guernsey',               'country_GG', '#92bfdb', 13),
    ('country_IM', 'regions', 'R1010', 'Isle of Man',            'country_IM', '#66a0c8', 14),
    ('country_JE', 'regions', 'R1010', 'Jersey',                 'country_JE', '#c6dde8', 15),
    ('country_SJ', 'regions', 'R1010', 'Svalbard and Jan Mayen', 'country_SJ', '#abcfe2', 16),
    -- Eastern Europe
    ('country_MD', 'regions', 'R1030', 'Moldova',                'country_MD', '#abcfe2', 10),
    -- Southern Europe
    ('country_MK', 'regions', 'R1040', 'North Macedonia',        'country_MK', '#92bfdb', 15),
    ('country_SI', 'regions', 'R1040', 'Slovenia',               'country_SI', '#66a0c8', 16),
    -- Caribbean
    ('country_BQ', 'regions', 'R2030', 'Bonaire, Sint Eustatius and Saba', 'country_BQ', '#c4b9e0', 27),
    ('country_CW', 'regions', 'R2030', 'Curaçao',                'country_CW', '#d3cae6', 28),
    -- South America
    ('country_BV', 'regions', 'R2040', 'Bouvet Island',          'country_BV', '#c4b9e0', 15),
    ('country_GS', 'regions', 'R2040', 'South Georgia and the South Sandwich Islands', 'country_GS', '#d3cae6', 16),
    -- Western Asia
    ('country_PS', 'regions', 'R3010', 'Palestine',              'country_PS', '#f4a4c2', 18),
    -- Northern Africa
    ('country_EH', 'regions', 'R4010', 'Western Sahara',         'country_EH', '#87d3c3', 7),
    -- Western Africa
    ('country_CI', 'regions', 'R4020', 'Côte d''Ivoire',          'country_CI', '#a2dece', 17),
    -- Australia and New Zealand
    ('country_CX', 'regions', 'R5010', 'Christmas Island',       'country_CX', '#bec97e', 4),
    ('country_CC', 'regions', 'R5010', 'Cocos (Keeling) Islands', 'country_CC', '#cdd597', 5),
    ('country_HM', 'regions', 'R5010', 'Heard Island and McDonald Islands', 'country_HM', '#a0af54', 6),
    -- Melanesia
    ('country_SB', 'regions', 'R5020', 'Solomon Islands',        'country_SB', '#bec97e', 5),
    -- Micronesia
    ('country_UM', 'regions', 'R5030', 'United States Minor Outlying Islands', 'country_UM', '#bec97e', 8);
