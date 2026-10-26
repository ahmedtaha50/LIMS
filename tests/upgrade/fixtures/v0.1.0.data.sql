-- Data of a B-Pharma LIMS v0.1.0 installation (commit cc95dbb), written by the ORIGINAL v0.1.0 server code:
-- the demo seed (src/server/seed_pg.ts), then signed workflows driven through its HTTP API
-- (register, results incl. one out-of-specification value, submit, review, approve, failed e-signature, notebook, ELN sign,
-- batch release, encrypted backup). Naive 'timestamp' values as the v0.1.0 schema stored them. Passwords are the demo password.
-- Loaded after v0.1.0.schema.sql and v0.1.0.protections.sql by tests/upgrade/helpers.ts.
-- Data for Name: audit_trail; Type: TABLE DATA; Schema: public; Owner: lims
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-e950fb6a8138', 1, '2026-10-13 13:15:53.650553', '2026-10-13T13:15:53.649Z', 'usr-admin', 'Create', 'Sample', 'SMP-2026-00001', 'all', '', '{"material":"Paracetamol 500mg Finished Tablets","batch":"BATCH-2026-001"}', 'Initial Batch Registration', 'f71121ec100b95acb4554b7661b315c726be099391dfcf6eddf091fdda5f82af', '0000000000000000000000000000000000000000000000000000000000000000');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-ee65367e77f1', 2, '2026-10-13 13:15:53.652154', '2026-10-13T13:15:53.651Z', 'usr-admin', 'Dispense', 'BatchMaterial', 'BM-PARA-API', 'quantityDispensed', '', '500.00 kg API Dispensed & CoA Verified', 'Dispensing per Manufacturing Order MO-2026-104', '848985c6063890e8a4772f1b88a7a6017869bba3beb168eb9d5f984683966246', 'f71121ec100b95acb4554b7661b315c726be099391dfcf6eddf091fdda5f82af');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-50bbf96af4fe', 3, '2026-10-13 13:15:53.653443', '2026-10-13T13:15:53.652Z', 'usr-admin', 'Update', 'Result', 'RES-001-1', 'value', '', '99.8', 'HPLC Assay result quantified per USP <621>', '8289f4a1dd03643ae94cd9d717b269d118a8bbd8a390705287770480bb903d33', '848985c6063890e8a4772f1b88a7a6017869bba3beb168eb9d5f984683966246');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-916b1e112122', 4, '2026-10-13 13:15:53.654487', '2026-10-13T13:15:53.654Z', 'usr-admin', 'Update', 'Result', 'RES-001-2', 'value', '', '94.2', 'Dissolution testing completed per USP <711>', '5807f01adad7792652e07a324540ec45bfb1dc465ab38fac37d218b495f83220', '8289f4a1dd03643ae94cd9d717b269d118a8bbd8a390705287770480bb903d33');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-c0e9d316cdca', 5, '2026-10-13 13:15:53.655309', '2026-10-13T13:15:53.654Z', 'usr-admin', 'Approve', 'Sample', 'SMP-2026-00001', 'state', 'Pending Review', 'Approved', 'All analytical specifications confirmed within limits', '36d78d21b7dc53a4c0a69be1d0ad4270b4d9d242887c42d08ed71d618ee75bc0', '5807f01adad7792652e07a324540ec45bfb1dc465ab38fac37d218b495f83220');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-acfc66895d97', 6, '2026-10-13 13:15:53.656114', '2026-10-13T13:15:53.655Z', 'usr-admin', 'Create', 'Sample', 'SMP-2026-00002', 'all', '', '{"material":"Amoxicillin 250mg/5mL Oral Suspension","batch":"BATCH-2026-002"}', 'Initial Batch Registration', '4d844d06e6ab0d706dbfe91c8a1530070ae9a7320b89e399b543e27a0f1316b5', '36d78d21b7dc53a4c0a69be1d0ad4270b4d9d242887c42d08ed71d618ee75bc0');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-8cc741f95678', 7, '2026-10-13 13:15:53.657047', '2026-10-13T13:15:53.656Z', 'usr-admin', 'Release', 'BatchRelease', 'BATCH-2026-002', 'status', 'Quarantine', 'Released', 'Qualified Person final release authorization', 'a0c2122d387fcca3fabb044f5cbf1224b467d7d15e34c8a6ea23607b8ab1a05a', '4d844d06e6ab0d706dbfe91c8a1530070ae9a7320b89e399b543e27a0f1316b5');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-d90a46796ffc9798', 8, '2026-10-13 13:16:51.69451', '2026-10-13T13:16:51.700Z', 'usr-analyst1', 'Create', 'Sample', 'SMP-2026-00004', 'field', '', '{"material":"Paracetamol 500mg Finished Tablets","batch":"B-FIX-1"}', 'System Registration', 'd284b49f74ffed22329e910679e662dbb098b3c13afcfa259e9688d273043d57', 'a0c2122d387fcca3fabb044f5cbf1224b467d7d15e34c8a6ea23607b8ab1a05a');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-4e61ada7b5530f6e', 9, '2026-10-13 13:16:51.725203', '2026-10-13T13:16:51.729Z', 'usr-analyst1', 'Update', 'Result', 'res-bebfaebc', 'value', '', '99.9', 'Initial entry per STP-014', '750226205e2b9818a2190aa95c8a6f574bc7d37f8aca9b51315ee81de31c81b0', 'd284b49f74ffed22329e910679e662dbb098b3c13afcfa259e9688d273043d57');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-8ea3912b98e7ac00', 10, '2026-10-13 13:16:51.737414', '2026-10-13T13:16:51.740Z', 'usr-analyst1', 'Update', 'Result', 'res-45dfcac2', 'value', '', '91.2', 'Initial entry per STP-014', '5899d5224f0b6cb65e75d41accacdec3980f9f497b085c4f5b44c1d3fb31c7a3', '750226205e2b9818a2190aa95c8a6f574bc7d37f8aca9b51315ee81de31c81b0');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-7ee601fb59fc8793', 11, '2026-10-13 13:16:51.748176', '2026-10-13T13:16:51.751Z', 'usr-analyst1', 'Update', 'Result', 'res-a2ca81c4', 'value', '', '0.002', 'Initial entry per STP-014', '39d2cdb3fece08926f4154f336732a9377b797f732c33ecfb3a6ba3b34f98057', '5899d5224f0b6cb65e75d41accacdec3980f9f497b085c4f5b44c1d3fb31c7a3');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-245aa6c2de88e770', 12, '2026-10-13 13:16:51.758229', '2026-10-13T13:16:51.761Z', 'usr-analyst1', 'Update', 'Result', 'res-c53f060d', 'value', '', '0.21', 'Initial entry per STP-014', '064c595245f006f7baa7c89cd24b0d02d787b83073edee37c6ca4e68d755b730', '39d2cdb3fece08926f4154f336732a9377b797f732c33ecfb3a6ba3b34f98057');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-48c550cc25c95281', 13, '2026-10-13 13:16:51.768288', '2026-10-13T13:16:51.772Z', 'usr-analyst1', 'Update', 'Result', 'res-50ce6397', 'value', '', '1.4', 'Initial entry per STP-014', 'e600fc8e50f46e2e665a1846609ed14ecf2e84ae2583aea8341711384c542356', '064c595245f006f7baa7c89cd24b0d02d787b83073edee37c6ca4e68d755b730');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-6fd0151a0c4284a3', 14, '2026-10-13 13:16:51.778424', '2026-10-13T13:16:51.781Z', 'usr-analyst1', 'Update', 'Result', 'res-ebd6f195', 'value', '', '6.5', 'Initial entry per STP-014', '0342c5cb45fc0a3c67c10f146ac24d06ed9e8dd1ce3c47b1ef32ff27830c012b', 'e600fc8e50f46e2e665a1846609ed14ecf2e84ae2583aea8341711384c542356');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-707907e60f62341a', 15, '2026-10-13 13:16:51.797089', '2026-10-13T13:16:51.800Z', 'usr-analyst1', 'Transition', 'Sample', 'SMP-2026-00004', 'state', 'Logged', 'Testing', 'Transition via submit', 'fde387c617b430adbf9adafc0c2601b79ac6c21dd729bb275786beb629b2b429', '0342c5cb45fc0a3c67c10f146ac24d06ed9e8dd1ce3c47b1ef32ff27830c012b');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-f3b3191a0f0490bf', 16, '2026-10-13 13:16:51.864309', '2026-10-13T13:16:51.867Z', 'usr-analyst1', 'SignatureFailed', 'Sample', 'SMP-2026-00004', 'signature', '', '', 'Failed password verification for Sample review (Attempt 1/3)', '824c7f6cefb2df4416b8d89963be4a9e40a7e368eb8b46c2abada9c79f64d20e', 'fde387c617b430adbf9adafc0c2601b79ac6c21dd729bb275786beb629b2b429');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-e51db11ba96a878e', 17, '2026-10-13 13:16:51.889594', '2026-10-13T13:16:51.946Z', 'usr-analyst1', 'Transition', 'Sample', 'SMP-2026-00004', 'state', 'Testing', 'Pending Review', 'Transition via review', '2ec5c34133ead4f1c84bffffb5138a6b1e4fb91b9d5e436a70446ea6225d3cdb', '824c7f6cefb2df4416b8d89963be4a9e40a7e368eb8b46c2abada9c79f64d20e');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-e73b7574d2501d94', 18, '2026-10-13 13:16:51.9617', '2026-10-13T13:16:52.015Z', 'usr-reviewer', 'Transition', 'Sample', 'SMP-2026-00004', 'state', 'Pending Review', 'Approved', 'All results within specification', '136687c896d61d6db17e47e8f8e70d20845a992beb81294d05af64e51075dd35', '2ec5c34133ead4f1c84bffffb5138a6b1e4fb91b9d5e436a70446ea6225d3cdb');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-f11a1544741f2081', 19, '2026-10-13 13:16:52.023212', '2026-10-13T13:16:52.025Z', 'usr-analyst2', 'Create', 'Sample', 'SMP-2026-00005', 'field', '', '{"material":"Paracetamol 500mg Finished Tablets","batch":"B-FIX-2"}', 'System Registration', 'd5a0d74b8f49288a2a28cfe57ec774dbfe249c61f770a3417d5c2d4ec2d52b05', '136687c896d61d6db17e47e8f8e70d20845a992beb81294d05af64e51075dd35');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-40dd2b6b9c0b1ed4', 20, '2026-10-13 13:16:52.041216', '2026-10-13T13:16:52.045Z', 'usr-analyst2', 'Update', 'Result', 'res-25df5303', 'value', '', '96.1', 'Initial entry', 'e80958e3c202bf8cf40f96b5a85d5faedc503300ff596f6cb304db872fbebbfc', 'd5a0d74b8f49288a2a28cfe57ec774dbfe249c61f770a3417d5c2d4ec2d52b05');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-854d986f4e734e7f', 21, '2026-10-13 13:16:52.052285', '2026-10-13T13:16:52.055Z', 'usr-analyst2', 'Update', 'Result', 'res-e033a59d', 'value', '', '1.0', 'Initial entry', '8809f25131ac2cde5d08379c67670c73b862ed98a4e34d09265142ac03b89cdd', 'e80958e3c202bf8cf40f96b5a85d5faedc503300ff596f6cb304db872fbebbfc');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-8f52d80f104e2d52', 22, '2026-10-13 13:16:52.128943', '2026-10-13T13:16:52.133Z', 'usr-analyst2', 'Create', 'LabNotebook', 'NOTE-YLNK9QRRE', 'content', '', 'Observed slight turbidity in the sample solution before filtration.', 'Lab observation captured', 'ab856077ad9d118cf1e6f7f87aa737fe65a5cd7e7713b113998b0dfab525e3c7', '8809f25131ac2cde5d08379c67670c73b862ed98a4e34d09265142ac03b89cdd');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-d776fedd617a4fb1', 23, '2026-10-13 13:16:52.139973', '2026-10-13T13:16:52.142Z', 'usr-analyst1', 'Create', 'LabNotebook', 'ELN-4BB7F906', 'all', '', '{"title":"HPLC assay worksheet B-FIX-1","experimentType":"HPLC"}', 'Created ELN Worksheet', '4e67757f528080de168e83e46b8e997c18d60cfd56f19c4c5a9b7b42a12b42ac', 'ab856077ad9d118cf1e6f7f87aa737fe65a5cd7e7713b113998b0dfab525e3c7');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-1a3afc76135866f4', 24, '2026-10-13 13:16:52.196181', '2026-10-13T13:16:52.200Z', 'usr-analyst1', 'SIGN_ELN_ENTRY', 'LabNotebook', 'ELN-4BB7F906', 'status', 'Draft', 'Signed', '21 CFR Part 11 Digital Signature Applied (Hash: 90d40bced87bdce4...)', '6692dbc67397ddec57901445561f16d61fbadf97c9044d3790d00ae8419f2b2c', '4e67757f528080de168e83e46b8e997c18d60cfd56f19c4c5a9b7b42a12b42ac');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-74fab2d1ede57360', 25, '2026-10-13 13:16:52.208029', '2026-10-13T13:16:52.209Z', 'usr-admin', 'Create', 'Instrument', 'INST-6ca98e2f', 'all', '', '{"id":"INST-6ca98e2f","name":"HPLC-02","type":"HPLC","status":"Active","calibrationDueDate":"2027-06-30","lastCalibrationDate":"2026-10-13T13:16:52.208Z"}', 'System Registration', '3236ee42e47af07d29d4c0751a34fc27b84a51714fdf849271f965229aa2c553', '6692dbc67397ddec57901445561f16d61fbadf97c9044d3790d00ae8419f2b2c');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-13248c3baf505b4d', 26, '2026-10-13 13:16:52.216733', '2026-10-13T13:16:52.218Z', 'usr-analyst1', 'Create', 'Reagent', 'RGT-78a4d3dc', 'all', '', '{"id":"RGT-78a4d3dc","name":"Acetonitrile HPLC grade","lotNumber":"LOT-FX-1","expiryDate":"2027-12-31","quantity":"2.5 L","status":"Available"}', 'System Registration', '163d8a235a6fab004b494fadc4af33270ce61f76a422d734ed0a7175772b6dba', '3236ee42e47af07d29d4c0751a34fc27b84a51714fdf849271f965229aa2c553');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-3fee308d0cb7f0e7', 27, '2026-10-13 13:16:52.224816', '2026-10-13T13:16:52.227Z', 'usr-analyst1', 'Create', 'EnvRecord', 'ENV-fb37397b', 'all', '', '{"id":"ENV-fb37397b","location":"Cleanroom A","grade":"A","date":"2026-10-01","viableCount":0,"nonViableCount":120,"status":"Pass","testedBy":"usr-analyst1"}', 'System Registration', '6e5d574aa5b998944cde48fa400b1e9ed49adbf3101d23e9764d56cc0cdf551b', '163d8a235a6fab004b494fadc4af33270ce61f76a422d734ed0a7175772b6dba');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-d7633681cbf01c94', 28, '2026-10-13 13:16:52.283255', '2026-10-13T13:16:52.286Z', 'usr-admin', 'Update', 'SystemSettings', 'default', 'security_policies', '{}', '{"sessionTimeoutMinutes":20,"updatedAt":"2026-10-13T13:16:52.282Z"}', 'Admin updated security settings', '9be8d3171b8439218768a54099c8615c8156324685957619f7936d73b0a2f63b', '6e5d574aa5b998944cde48fa400b1e9ed49adbf3101d23e9764d56cc0cdf551b');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-44f9b34b4c4ecf2a', 29, '2026-10-13 13:16:52.344086', '2026-10-13T13:16:52.349Z', 'usr-qa', 'Release', 'BatchRelease', 'B-FIX-1', 'status', 'Quarantine', 'Released', '21 CFR Part 11 QP Release Authorization Seal: cd203881be790416...', 'c034a81c89dd3277a0b8229a99c8f574535ae962fa504fe8b42667ff578ba79a', '9be8d3171b8439218768a54099c8615c8156324685957619f7936d73b0a2f63b');
INSERT INTO public.audit_trail (id, sequence, "timestamp", timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash) VALUES ('adt-074dde7fddd25ed7', 30, '2026-10-13 13:16:52.522283', '2026-10-13T13:16:52.523Z', 'usr-admin', 'BACKUP_CREATED', 'System', 'bplims-2026-10-13T13-16-52-420Z.bak', 'backup', '', 'sha256=69433e035cffb9ab8697cb0cff2b7ff50a095e7fbc78b97d46419f9dcbeb1b8e; auditHead=29', 'Scheduled/manual backup', '53f6e3f82fbb566f34c7876ddf1e428e6c2e254016c46ad4347b224bc6dfb11e', 'c034a81c89dd3277a0b8229a99c8f574535ae962fa504fe8b42667ff578ba79a');


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: lims
--

INSERT INTO public.users (id, uid, name, role, active, password_hash, password_changed_at, email, failed_attempts, locked_at, has_completed_software_training, created_at, totp_secret, totp_enabled) VALUES ('usr-admin', 'admin', 'Dr. Sarah Jenkins', 'Admin', true, '70d5dc954b9a56ca1c925d2b4ae7aea7091881f6e43379d92d0c0756b64fe4adf0e9fd75c3bf290bba2f05f199c36146adf9b4fefdd9dab3c4bdfa0d25a572f9', '2026-10-13 13:15:53.621417', 'admin@gxp.com', 0, NULL, true, '2026-10-13 13:15:53.621417', NULL, false);
INSERT INTO public.users (id, uid, name, role, active, password_hash, password_changed_at, email, failed_attempts, locked_at, has_completed_software_training, created_at, totp_secret, totp_enabled) VALUES ('usr-qa', 'qa', 'Marcus Vance, QA Officer', 'QA', true, '70d5dc954b9a56ca1c925d2b4ae7aea7091881f6e43379d92d0c0756b64fe4adf0e9fd75c3bf290bba2f05f199c36146adf9b4fefdd9dab3c4bdfa0d25a572f9', '2026-10-13 13:15:53.621417', 'qa@gxp.com', 0, NULL, true, '2026-10-13 13:15:53.621417', NULL, false);
INSERT INTO public.users (id, uid, name, role, active, password_hash, password_changed_at, email, failed_attempts, locked_at, has_completed_software_training, created_at, totp_secret, totp_enabled) VALUES ('usr-reviewer', 'reviewer', 'Dr. Elena Rostova', 'Reviewer', true, '70d5dc954b9a56ca1c925d2b4ae7aea7091881f6e43379d92d0c0756b64fe4adf0e9fd75c3bf290bba2f05f199c36146adf9b4fefdd9dab3c4bdfa0d25a572f9', '2026-10-13 13:15:53.621417', 'reviewer@gxp.com', 0, NULL, true, '2026-10-13 13:15:53.621417', NULL, false);
INSERT INTO public.users (id, uid, name, role, active, password_hash, password_changed_at, email, failed_attempts, locked_at, has_completed_software_training, created_at, totp_secret, totp_enabled) VALUES ('usr-analyst2', 'analyst2', 'Claire Dupont, Chemist', 'Analyst', true, '70d5dc954b9a56ca1c925d2b4ae7aea7091881f6e43379d92d0c0756b64fe4adf0e9fd75c3bf290bba2f05f199c36146adf9b4fefdd9dab3c4bdfa0d25a572f9', '2026-10-13 13:15:53.621417', 'analyst2@gxp.com', 0, NULL, true, '2026-10-13 13:15:53.621417', NULL, false);
INSERT INTO public.users (id, uid, name, role, active, password_hash, password_changed_at, email, failed_attempts, locked_at, has_completed_software_training, created_at, totp_secret, totp_enabled) VALUES ('usr-analyst1', 'analyst1', 'Ahmed Taha, QC Analyst', 'Analyst', true, '70d5dc954b9a56ca1c925d2b4ae7aea7091881f6e43379d92d0c0756b64fe4adf0e9fd75c3bf290bba2f05f199c36146adf9b4fefdd9dab3c4bdfa0d25a572f9', '2026-10-13 13:15:53.621417', 'analyst1@gxp.com', 0, NULL, true, '2026-10-13 13:15:53.621417', NULL, false);


--
-- Data for Name: batch_materials; Type: TABLE DATA; Schema: public; Owner: lims
--

INSERT INTO public.batch_materials (id, batch, material_name, material_type, lot_number, manufacturer, coa_number, coa_status, quantity_dispensed, potency_assay, loss_on_drying, dispensed_by, verified_by, dispensed_at, version) VALUES ('BM-PARA-API', 'BATCH-2026-001', 'Paracetamol BP/USP Micropowder', 'API (Active Pharmaceutical Ingredient)', 'API-PARA-2026-081', 'Mallinckrodt Pharmaceuticals LLC', 'COA-MALL-88129', 'Verified Pass', '500.00 kg', '99.85 %', '0.18 %', 'usr-analyst1', 'usr-qa', '2026-10-13 13:15:53.639099', 1);
INSERT INTO public.batch_materials (id, batch, material_name, material_type, lot_number, manufacturer, coa_number, coa_status, quantity_dispensed, potency_assay, loss_on_drying, dispensed_by, verified_by, dispensed_at, version) VALUES ('BM-PARA-MCC', 'BATCH-2026-001', 'Microcrystalline Cellulose (Avicel PH-102)', 'Excipient (Binder & Disintegrant)', 'MCC-2025-9941', 'FMC Biopolymer Europe', 'COA-FMC-4102', 'Verified Pass', '120.00 kg', '100.00 %', '4.10 %', 'usr-analyst1', 'usr-qa', '2026-10-13 13:15:53.639099', 1);
INSERT INTO public.batch_materials (id, batch, material_name, material_type, lot_number, manufacturer, coa_number, coa_status, quantity_dispensed, potency_assay, loss_on_drying, dispensed_by, verified_by, dispensed_at, version) VALUES ('BM-PARA-STA', 'BATCH-2026-001', 'Pregelatinized Maize Starch (Starch 1500)', 'Excipient (Binder)', 'STA-2025-3318', 'Colorcon Inc.', 'COA-COL-1099', 'Verified Pass', '45.00 kg', '100.00 %', '7.80 %', 'usr-analyst1', 'usr-qa', '2026-10-13 13:15:53.639099', 1);
INSERT INTO public.batch_materials (id, batch, material_name, material_type, lot_number, manufacturer, coa_number, coa_status, quantity_dispensed, potency_assay, loss_on_drying, dispensed_by, verified_by, dispensed_at, version) VALUES ('BM-PARA-MGS', 'BATCH-2026-001', 'Magnesium Stearate (Vegetable Origin)', 'Excipient (Lubricant)', 'MGS-2026-1120', 'Peter Greven GMBH', 'COA-PG-5014', 'Verified Pass', '5.00 kg', '99.20 %', '3.40 %', 'usr-analyst1', 'usr-qa', '2026-10-13 13:15:53.639099', 1);
INSERT INTO public.batch_materials (id, batch, material_name, material_type, lot_number, manufacturer, coa_number, coa_status, quantity_dispensed, potency_assay, loss_on_drying, dispensed_by, verified_by, dispensed_at, version) VALUES ('BM-AMX-API', 'BATCH-2026-002', 'Amoxicillin Trihydrate Compacted Powder', 'API (Active Pharmaceutical Ingredient)', 'AMX-2026-0144', 'Sandoz / Centrient Pharmaceuticals', 'COA-CENT-9021', 'Verified Pass', '150.00 kg', '87.40 % (as anhydrous)', '13.20 % (Water KF)', 'usr-analyst2', 'usr-qa', '2026-10-13 13:15:53.639099', 1);
INSERT INTO public.batch_materials (id, batch, material_name, material_type, lot_number, manufacturer, coa_number, coa_status, quantity_dispensed, potency_assay, loss_on_drying, dispensed_by, verified_by, dispensed_at, version) VALUES ('BM-AMX-SBZ', 'BATCH-2026-002', 'Sodium Benzoate BP/USP', 'Excipient (Antimicrobial Preservative)', 'SBZ-2025-883', 'Emerald Performance Materials', 'COA-EM-4421', 'Verified Pass', '3.00 kg', '99.90 %', '0.45 %', 'usr-analyst2', 'usr-qa', '2026-10-13 13:15:53.639099', 1);
INSERT INTO public.batch_materials (id, batch, material_name, material_type, lot_number, manufacturer, coa_number, coa_status, quantity_dispensed, potency_assay, loss_on_drying, dispensed_by, verified_by, dispensed_at, version) VALUES ('BM-CIP-API', 'BATCH-2026-003', 'Ciprofloxacin Hydrochloride Monohydrate USP', 'API (Active Pharmaceutical Ingredient)', 'CIP-2026-5510', 'Bayer HealthCare Pharma', 'COA-BAY-3320', 'Verified Pass', '280.00 kg', '99.60 %', '5.20 %', 'usr-analyst1', 'usr-qa', '2026-10-13 13:15:53.639099', 1);


--
-- Data for Name: batch_releases; Type: TABLE DATA; Schema: public; Owner: lims
--

INSERT INTO public.batch_releases (id, batch, status, disposition_recommendation, released_by, released_at, meaning, content_hash, signature_id, audit_entry_id, version) VALUES ('BR-2026-002', 'BATCH-2026-002', 'Released', 'Conforms to all registered European & USP Pharmacopeia specifications. Released for market distribution.', 'usr-qa', '2026-02-13 17:00:00', 'Final Batch Release Disposition & Market Authorization (EU GMP / FDA 21 CFR Part 211.188)', '0cbe07a34e01062e6067d40f455a7eb41a26b7f317cd46fd3adc5490d43f0d07', 'SIG-BR-002', 'adt-release-002', 1);
INSERT INTO public.batch_releases (id, batch, status, disposition_recommendation, released_by, released_at, meaning, content_hash, signature_id, audit_entry_id, version) VALUES ('BR-88CE34CC', 'B-FIX-1', 'Released', 'Release', 'usr-qa', '2026-10-13 13:16:52.344', 'Final Batch Release Disposition & Market Authorization (EU GMP / FDA 21 CFR Part 211.188)', 'cd203881be790416d8d002f131099cd4b7f11ea8e4950d851b9bf94cb2efeb57', 'SIG-REL-F284342F', 'adt-44f9b34b4c4ecf2a', 1);


--
-- Data for Name: env_records; Type: TABLE DATA; Schema: public; Owner: lims
--

INSERT INTO public.env_records (id, location, grade, date, viable_count, non_viable_count, status, tested_by, version) VALUES ('ENV-2026-001', 'Aseptic Filling Line 1 - Laminar Flow Hood', 'Grade A', '2026-02-10', 0, 0, 'Pass', 'usr-qa', 1);
INSERT INTO public.env_records (id, location, grade, date, viable_count, non_viable_count, status, tested_by, version) VALUES ('ENV-2026-002', 'Cleanroom Core Suite 104', 'Grade B', '2026-02-10', 2, 320, 'Pass', 'usr-qa', 1);
INSERT INTO public.env_records (id, location, grade, date, viable_count, non_viable_count, status, tested_by, version) VALUES ('ENV-2026-003', 'Granulation & Blending Suite 201', 'Grade C', '2026-02-11', 8, 4200, 'Pass', 'usr-qa', 1);
INSERT INTO public.env_records (id, location, grade, date, viable_count, non_viable_count, status, tested_by, version) VALUES ('ENV-2026-004', 'Personnel Airlock PAL-02', 'Grade D', '2026-02-11', 15, 18000, 'Pass', 'usr-qa', 1);
INSERT INTO public.env_records (id, location, grade, date, viable_count, non_viable_count, status, tested_by, version) VALUES ('ENV-2026-005', 'Tablet Compression Suite 305', 'Grade C', '2026-02-12', 12, 5100, 'Pass', 'usr-qa', 1);
INSERT INTO public.env_records (id, location, grade, date, viable_count, non_viable_count, status, tested_by, version) VALUES ('ENV-2026-006', 'Primary Blister Packaging Room', 'Grade D', '2026-02-12', 22, 24500, 'Pass', 'usr-qa', 1);
INSERT INTO public.env_records (id, location, grade, date, viable_count, non_viable_count, status, tested_by, version) VALUES ('ENV-fb37397b', 'Cleanroom A', 'A', '2026-10-01', 0, 120, 'Pass', 'usr-analyst1', 1);


--
-- Data for Name: instruments; Type: TABLE DATA; Schema: public; Owner: lims
--

INSERT INTO public.instruments (id, name, type, status, calibration_due_date, last_calibration_date) VALUES ('INST-HPLC-01', 'Agilent 1260 Infinity II HPLC System', 'Chromatography', 'Active', '2027-10-13', '2026-01-15');
INSERT INTO public.instruments (id, name, type, status, calibration_due_date, last_calibration_date) VALUES ('INST-UV-02', 'Shimadzu UV-1900i Spectrophotometer', 'Spectroscopy', 'Active', '2027-10-13', '2026-01-10');
INSERT INTO public.instruments (id, name, type, status, calibration_due_date, last_calibration_date) VALUES ('INST-DIS-03', 'Hanson Vision G2 Dissolution Tester', 'Dissolution', 'Active', '2027-10-13', '2026-01-12');
INSERT INTO public.instruments (id, name, type, status, calibration_due_date, last_calibration_date) VALUES ('INST-BAL-04', 'Mettler Toledo XPE205 Analytical Balance', 'Weighing', 'Active', '2027-10-13', '2026-01-05');
INSERT INTO public.instruments (id, name, type, status, calibration_due_date, last_calibration_date) VALUES ('INST-6ca98e2f', 'HPLC-02', 'HPLC', 'Active', '2027-06-30', '2026-10-13T13:16:52.208Z');


--
-- Data for Name: jobs; Type: TABLE DATA; Schema: public; Owner: lims
--



--
-- Data for Name: samples; Type: TABLE DATA; Schema: public; Owner: lims
--

INSERT INTO public.samples (id, material, batch, state, created_by, created_at, version) VALUES ('SMP-2026-00001', 'Paracetamol 500mg Finished Tablets', 'BATCH-2026-001', 'Approved', 'usr-analyst1', '2026-10-13 13:15:53.644142', 2);
INSERT INTO public.samples (id, material, batch, state, created_by, created_at, version) VALUES ('SMP-2026-00002', 'Amoxicillin 250mg/5mL Oral Suspension', 'BATCH-2026-002', 'Approved', 'usr-analyst2', '2026-10-13 13:15:53.644142', 2);
INSERT INTO public.samples (id, material, batch, state, created_by, created_at, version) VALUES ('SMP-2026-00003', 'Ciprofloxacin 500mg Film-Coated Tablets', 'BATCH-2026-003', 'Testing', 'usr-analyst1', '2026-10-13 13:15:53.644142', 1);
INSERT INTO public.samples (id, material, batch, state, created_by, created_at, version) VALUES ('SMP-2026-00004', 'Paracetamol 500mg Finished Tablets', 'B-FIX-1', 'Approved', 'usr-analyst1', '2026-10-13 13:16:51.69451', 4);
INSERT INTO public.samples (id, material, batch, state, created_by, created_at, version) VALUES ('SMP-2026-00005', 'Paracetamol 500mg Finished Tablets', 'B-FIX-2', 'Logged', 'usr-analyst2', '2026-10-13 13:16:52.023212', 1);


--
-- Data for Name: lab_notebook; Type: TABLE DATA; Schema: public; Owner: lims
--

INSERT INTO public.lab_notebook (id, title, sample_id, content, experiment_type, status, entered_by, entered_at, signed_at, signed_by, signature_meaning, content_hash, version, locked, pharmacopeia) VALUES ('ELN-2026-001', 'HPLC Assay & System Suitability Worksheet — Paracetamol 500mg', 'SMP-2026-00001', '# High Performance Liquid Chromatography (HPLC) Quantitative Assay
## Regulatory Reference: USP <621> Chromatography & USP Monograph for Acetaminophen Tablets

### 1. Objective & Scope
Quantitative determination of Paracetamol in finished tablet formulation batch BATCH-2026-001 using validated reverse-phase isocratic HPLC with UV detection at 243 nm.

### 2. Instrumentation & Chromatographic Setup
- **System:** Agilent 1260 Infinity II Quaternary Pump & DAD Detector (INST-HPLC-01)
- **Stationary Phase:** C18 Reverse-Phase, 250 mm × 4.6 mm ID, 5 µm particle size (L1 column chemistry)
- **Mobile Phase:** Methanol : HPLC Grade Water : Glacial Acetic Acid (28 : 69 : 3 v/v/v), degassed and filtered through 0.22 µm nylon membrane
- **Flow Rate:** 1.5 mL/min isocratic
- **Column Temperature:** 35.0 °C ± 0.5 °C
- **Detection Wavelength:** λ = 243 nm
- **Injection Volume:** 10.0 µL

### 3. System Suitability Test (SST) Criteria & Observed Values
| Parameter | Acceptance Limit (USP <621>) | Observed Value | Result |
| :--- | :--- | :--- | :--- |
| Retention Time (%RSD, n=5) | ≤ 1.0 % | 0.24 % | **PASS** |
| Peak Area Repeatability (%RSD, n=5) | ≤ 1.0 % | 0.42 % | **PASS** |
| Theoretical Plates (N) | ≥ 2,500 | 4,820 | **PASS** |
| USP Tailing Factor (T) | 0.8 to 1.5 | 1.12 | **PASS** |

### 4. Preparation Procedure & Cleanroom Voice Notes
- **Standard Solution:** Accurately weighed 50.12 mg of USP Reference Standard (Lot RS-2026-904) into 50 mL Class A volumetric flask. Dissolved in 30 mL mobile phase under 10 min sonication, made to volume. Diluted 5.0 mL to 50.0 mL. Nominal concentration: 0.1002 mg/mL.
- **Sample Solution:** Accurately weighed 20 whole tablets. Average tablet weight: 582.4 mg. Powdered finely. Weighed 58.2 mg equivalent powder, transferred to 50 mL volumetric flask, sonicated 15 min, filtered through 0.45 µm PTFE syringe filter. Diluted 5.0 mL to 50.0 mL.
- **Voice Dictation Entry (Aseptic Room 104):** *"System suitability injections completed at 09:15 AM. Baseline stable with noise < 0.05 mAU. Sample duplicate injections show sharp, symmetrical peak at retention time 4.22 min. Zero ghost peaks observed."*

### 5. Quantitative Formula & Calculation
$$\text{Assay (\% Label Claim)} = \left( \frac{A_{\text{sample}}}{A_{\text{standard}}} \right) \times \left( \frac{W_{\text{std}}}{50} \right) \times \left( \frac{5}{50} \right) \times \left( \frac{50}{W_{\text{sample}}} \right) \times \left( \frac{50}{5} \right) \times \left( \frac{\text{Avg Tablet Weight}}{\text{Label Claim}} \right) \times P_{\text{std}} \times 100$$
$$\text{Assay} = \left( \frac{1482092}{1485120} \right) \times \left( \frac{50.12}{50} \right) \times \left( \frac{582.4}{500.0} \right) \times 0.9985 \times 100 = 99.82\%$$

### 6. Conclusion
The assay result of **99.8 %** complies with the USP specification limit of 98.0% to 102.0% of label claim.', 'HPLC Assay Quantitative', 'Signed', 'usr-analyst1', '2026-02-12 09:00:00', '2026-02-12 16:30:00', 'usr-analyst1', 'Authorship & Verification of Laboratory Records (21 CFR Part 11)', 'eaf8c9783abf8634ce4021fdd94cc802427f15e80aeaa8bdedc5902c75d739f9', 2, true, 'USP <621> / USP Monograph');
INSERT INTO public.lab_notebook (id, title, sample_id, content, experiment_type, status, entered_by, entered_at, signed_at, signed_by, signature_meaning, content_hash, version, locked, pharmacopeia) VALUES ('ELN-2026-002', 'In-Vitro Dissolution Profiling Worksheet — Amoxicillin Oral Suspension', 'SMP-2026-00002', '# Dissolution Testing Execution Worksheet
## Regulatory Framework: USP <711> Dissolution (Apparatus 2 - Paddle Method)

### 1. Test Parameters
- **Medium:** 900 mL of 0.1 N Hydrochloric Acid
- **Temperature:** 37.0 °C ± 0.5 °C
- **Rotational Speed:** 75 RPM
- **Sampling Timepoints:** 15, 30, 45, and 60 minutes
- **Filter:** 0.45 µm porous cannula filter

### 2. Analytical Execution & Observations
- Medium temperature verified across all 6 vessels at 37.0 °C.
- Tablets dropped simultaneously using automated dosage drop mechanism.
- Handled inside sterile glovebox; voice dictation recording active.
- Observed complete disintegration within 8 minutes.

### 3. Acceptance Limits
$Q = 80\%$ at 30 minutes.

### 4. Status
Testing worksheet in progress. Ready for second analyst verification signoff.', 'Dissolution Testing', 'Draft', 'usr-analyst2', '2026-02-13 08:30:00', NULL, NULL, NULL, NULL, 1, false, 'USP <711> Dissolution / EP 2.9.3');
INSERT INTO public.lab_notebook (id, title, sample_id, content, experiment_type, status, entered_by, entered_at, signed_at, signed_by, signature_meaning, content_hash, version, locked, pharmacopeia) VALUES ('NOTE-YLNK9QRRE', 'Sample Observation SMP-2026-00005', 'SMP-2026-00005', 'Observed slight turbidity in the sample solution before filtration.', 'General Analysis', 'Draft', 'usr-analyst2', '2026-10-13 13:16:52.13', NULL, NULL, NULL, NULL, 1, false, NULL);
INSERT INTO public.lab_notebook (id, title, sample_id, content, experiment_type, status, entered_by, entered_at, signed_at, signed_by, signature_meaning, content_hash, version, locked, pharmacopeia) VALUES ('ELN-4BB7F906', 'HPLC assay worksheet B-FIX-1', 'SMP-2026-00004', '# Worksheet
System suitability passed.', 'HPLC', 'Signed', 'usr-analyst1', '2026-10-13 13:16:52.14', '2026-10-13 13:16:52.196', 'usr-analyst1', 'Authorship', '90d40bced87bdce49464ad1daa6fca96a1a8a9b052079bd87ba9c31b9c3b6eac', 2, true, 'USP / EP Standard');


--
-- Data for Name: notebook_templates; Type: TABLE DATA; Schema: public; Owner: lims
--



--
-- Data for Name: results; Type: TABLE DATA; Schema: public; Owner: lims
--

INSERT INTO public.results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at, instrument_id, attachment_name, attachment_data, version) VALUES ('RES-001-1', 'SMP-2026-00001', 'HPLC Assay (% Label Claim)', '99.8', 98, 102, false, 'usr-analyst1', '2026-02-12 09:30:00', 'INST-HPLC-01', NULL, NULL, 2);
INSERT INTO public.results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at, instrument_id, attachment_name, attachment_data, version) VALUES ('RES-001-2', 'SMP-2026-00001', 'Dissolution (Q at 30 min, %)', '94.2', 80, 105, false, 'usr-analyst1', '2026-02-12 11:15:00', 'INST-DIS-03', NULL, NULL, 2);
INSERT INTO public.results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at, instrument_id, attachment_name, attachment_data, version) VALUES ('RES-001-3', 'SMP-2026-00001', '4-Aminophenol Impurity (%)', '0.0018', 0, 0.005, false, 'usr-analyst1', '2026-02-12 13:45:00', 'INST-HPLC-01', NULL, NULL, 2);
INSERT INTO public.results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at, instrument_id, attachment_name, attachment_data, version) VALUES ('RES-001-4', 'SMP-2026-00001', 'Total Related Substances (%)', '0.12', 0, 0.5, false, 'usr-analyst1', '2026-02-12 14:10:00', 'INST-HPLC-01', NULL, NULL, 2);
INSERT INTO public.results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at, instrument_id, attachment_name, attachment_data, version) VALUES ('RES-001-5', 'SMP-2026-00001', 'Karl Fischer Water Content (%)', '1.85', 0.1, 3, false, 'usr-analyst1', '2026-02-12 15:00:00', 'INST-BAL-04', NULL, NULL, 2);
INSERT INTO public.results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at, instrument_id, attachment_name, attachment_data, version) VALUES ('RES-001-6', 'SMP-2026-00001', 'Uniformity of Dosage Units (AV)', '3.8', 0, 15, false, 'usr-analyst1', '2026-02-12 15:45:00', 'INST-BAL-04', NULL, NULL, 2);
INSERT INTO public.results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at, instrument_id, attachment_name, attachment_data, version) VALUES ('RES-002-1', 'SMP-2026-00002', 'HPLC Assay (% Label Claim)', '91.5', 90, 120, false, 'usr-analyst2', '2026-02-13 10:00:00', 'INST-HPLC-01', NULL, NULL, 2);
INSERT INTO public.results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at, instrument_id, attachment_name, attachment_data, version) VALUES ('RES-002-2', 'SMP-2026-00002', 'pH Determination', '5.8', 5, 7.5, false, 'usr-analyst2', '2026-02-13 10:45:00', 'INST-UV-02', NULL, NULL, 2);
INSERT INTO public.results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at, instrument_id, attachment_name, attachment_data, version) VALUES ('RES-002-3', 'SMP-2026-00002', 'Deliverable Volume (mL)', '101.5', 100, 110, false, 'usr-analyst2', '2026-02-13 11:30:00', 'INST-BAL-04', NULL, NULL, 2);
INSERT INTO public.results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at, instrument_id, attachment_name, attachment_data, version) VALUES ('RES-002-4', 'SMP-2026-00002', 'Total Aerobic Microbial Count (CFU/g)', '10', 0, 100, false, 'usr-analyst2', '2026-02-13 14:00:00', 'INST-BAL-04', NULL, NULL, 2);
INSERT INTO public.results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at, instrument_id, attachment_name, attachment_data, version) VALUES ('RES-003-1', 'SMP-2026-00003', 'HPLC Assay (% Label Claim)', '99.1', 98, 102, false, 'usr-analyst1', '2026-02-14 09:00:00', 'INST-HPLC-01', NULL, NULL, 2);
INSERT INTO public.results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at, instrument_id, attachment_name, attachment_data, version) VALUES ('RES-003-2', 'SMP-2026-00003', 'Dissolution (Q at 30 min, %)', NULL, 80, 100, false, NULL, NULL, NULL, NULL, NULL, 1);
INSERT INTO public.results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at, instrument_id, attachment_name, attachment_data, version) VALUES ('RES-003-3', 'SMP-2026-00003', 'Fluoroquinolonic Acid Impurity (%)', NULL, 0, 0.2, false, NULL, NULL, NULL, NULL, NULL, 1);
INSERT INTO public.results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at, instrument_id, attachment_name, attachment_data, version) VALUES ('res-bebfaebc', 'SMP-2026-00004', 'HPLC Assay (% Label Claim)', '99.9', 98, 102, false, 'usr-analyst1', '2026-10-13 13:16:51.727', NULL, NULL, NULL, 2);
INSERT INTO public.results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at, instrument_id, attachment_name, attachment_data, version) VALUES ('res-45dfcac2', 'SMP-2026-00004', 'Dissolution (Q at 30 min, %)', '91.2', 80, 105, false, 'usr-analyst1', '2026-10-13 13:16:51.738', NULL, NULL, NULL, 2);
INSERT INTO public.results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at, instrument_id, attachment_name, attachment_data, version) VALUES ('res-a2ca81c4', 'SMP-2026-00004', '4-Aminophenol Impurity (%)', '0.002', 0, 0.005, false, 'usr-analyst1', '2026-10-13 13:16:51.749', NULL, NULL, NULL, 2);
INSERT INTO public.results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at, instrument_id, attachment_name, attachment_data, version) VALUES ('res-c53f060d', 'SMP-2026-00004', 'Total Related Substances (%)', '0.21', 0, 0.5, false, 'usr-analyst1', '2026-10-13 13:16:51.759', NULL, NULL, NULL, 2);
INSERT INTO public.results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at, instrument_id, attachment_name, attachment_data, version) VALUES ('res-50ce6397', 'SMP-2026-00004', 'Karl Fischer Water Content (%)', '1.4', 0.1, 3, false, 'usr-analyst1', '2026-10-13 13:16:51.77', NULL, NULL, NULL, 2);
INSERT INTO public.results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at, instrument_id, attachment_name, attachment_data, version) VALUES ('res-ebd6f195', 'SMP-2026-00004', 'Uniformity of Dosage Units (AV)', '6.5', 0, 15, false, 'usr-analyst1', '2026-10-13 13:16:51.779', NULL, NULL, NULL, 2);
INSERT INTO public.results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at, instrument_id, attachment_name, attachment_data, version) VALUES ('res-333e4cde', 'SMP-2026-00005', 'Dissolution (Q at 30 min, %)', NULL, 80, 105, false, NULL, NULL, NULL, NULL, NULL, 1);
INSERT INTO public.results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at, instrument_id, attachment_name, attachment_data, version) VALUES ('res-9f12a61a', 'SMP-2026-00005', '4-Aminophenol Impurity (%)', NULL, 0, 0.005, false, NULL, NULL, NULL, NULL, NULL, 1);
INSERT INTO public.results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at, instrument_id, attachment_name, attachment_data, version) VALUES ('res-c21a5283', 'SMP-2026-00005', 'Total Related Substances (%)', NULL, 0, 0.5, false, NULL, NULL, NULL, NULL, NULL, 1);
INSERT INTO public.results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at, instrument_id, attachment_name, attachment_data, version) VALUES ('res-2e167df7', 'SMP-2026-00005', 'Uniformity of Dosage Units (AV)', NULL, 0, 15, false, NULL, NULL, NULL, NULL, NULL, 1);
INSERT INTO public.results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at, instrument_id, attachment_name, attachment_data, version) VALUES ('res-25df5303', 'SMP-2026-00005', 'HPLC Assay (% Label Claim)', '96.1', 98, 102, true, 'usr-analyst2', '2026-10-13 13:16:52.042', NULL, NULL, NULL, 2);
INSERT INTO public.results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at, instrument_id, attachment_name, attachment_data, version) VALUES ('res-e033a59d', 'SMP-2026-00005', 'Karl Fischer Water Content (%)', '1.0', 0.1, 3, false, 'usr-analyst2', '2026-10-13 13:16:52.053', NULL, NULL, NULL, 2);


--
-- Data for Name: oos_investigations; Type: TABLE DATA; Schema: public; Owner: lims
--

INSERT INTO public.oos_investigations (id, sample_id, result_id, parameter, date_raised, status, assigned_to, root_cause, conclusion, version) VALUES ('OOS-2026-001', 'SMP-2026-00003', 'RES-003-1', 'HPLC Assay (% Label Claim)', '2026-09-18', 'Phase II QA Review', 'usr-qa', 'Column backpressure anomaly during chromatographic run', NULL, 1);


--
-- Data for Name: reagents; Type: TABLE DATA; Schema: public; Owner: lims
--

INSERT INTO public.reagents (id, name, lot_number, expiry_date, status, quantity) VALUES ('RGT-78a4d3dc', 'Acetonitrile HPLC grade', 'LOT-FX-1', '2027-12-31', 'Available', '2.5 L');


--
-- Data for Name: signatures; Type: TABLE DATA; Schema: public; Owner: lims
--

INSERT INTO public.signatures (id, sample_id, signer_id, meaning, reason, "timestamp", record_version, content_hash, audit_entry_id) VALUES ('sig-7d8aaf8559f8097d', 'SMP-2026-00004', 'usr-analyst1', 'Review & Verification of Analytical Results', 'review', '2026-10-13 13:16:51.889594', 3, '35f79b36dd1514a03526b6f1c18f9a83718fddd12e2174c04a608c07eda6646d', 'adt-e51db11ba96a878e');
INSERT INTO public.signatures (id, sample_id, signer_id, meaning, reason, "timestamp", record_version, content_hash, audit_entry_id) VALUES ('sig-a998fb35a28b73fb', 'SMP-2026-00004', 'usr-reviewer', 'Approval (Release Disposition)', 'All results within specification', '2026-10-13 13:16:51.9617', 4, '28957a5178bde9fa33a5a4b85c3b8d0a33259cdbbecabefbe47f6f1d0e78270b', 'adt-e73b7574d2501d94');
INSERT INTO public.signatures (id, sample_id, signer_id, meaning, reason, "timestamp", record_version, content_hash, audit_entry_id) VALUES ('SIG-O5PMSUG9Y', 'SMP-2026-00005', 'usr-analyst2', 'I am the author of this observation', 'Observation', '2026-10-13 13:16:52.131', 1, 'N/A', 'N/A');
INSERT INTO public.signatures (id, sample_id, signer_id, meaning, reason, "timestamp", record_version, content_hash, audit_entry_id) VALUES ('SIG-ELN-395C49EB', 'SMP-2026-00004', 'usr-analyst1', 'Authorship', 'Authorship', '2026-10-13 13:16:52.196', 2, '90d40bced87bdce49464ad1daa6fca96a1a8a9b052079bd87ba9c31b9c3b6eac', 'adt-1a3afc76135866f4');
INSERT INTO public.signatures (id, sample_id, signer_id, meaning, reason, "timestamp", record_version, content_hash, audit_entry_id) VALUES ('SIG-REL-F284342F', 'SMP-2026-00004', 'usr-qa', 'Final Batch Release Disposition & Market Authorization (EU GMP / FDA 21 CFR Part 211.188)', 'Batch meets all release criteria', '2026-10-13 13:16:52.344', 1, 'cd203881be790416d8d002f131099cd4b7f11ea8e4950d851b9bf94cb2efeb57', 'adt-44f9b34b4c4ecf2a');


--
-- Data for Name: specifications; Type: TABLE DATA; Schema: public; Owner: lims
--

INSERT INTO public.specifications (id, material, version, effective_date, status, parameters) VALUES ('SPEC-PARA-500', 'Paracetamol 500mg Finished Tablets', 1, '2026-01-01', 'Active', '[{"max": 102, "min": 98, "name": "HPLC Assay (% Label Claim)"}, {"max": 105, "min": 80, "name": "Dissolution (Q at 30 min, %)"}, {"max": 0.005, "min": 0, "name": "4-Aminophenol Impurity (%)"}, {"max": 0.5, "min": 0, "name": "Total Related Substances (%)"}, {"max": 3, "min": 0.1, "name": "Karl Fischer Water Content (%)"}, {"max": 15, "min": 0, "name": "Uniformity of Dosage Units (AV)"}]');
INSERT INTO public.specifications (id, material, version, effective_date, status, parameters) VALUES ('SPEC-AMX-250', 'Amoxicillin 250mg/5mL Oral Suspension', 1, '2026-01-01', 'Active', '[{"max": 120, "min": 90, "name": "HPLC Assay (% Label Claim)"}, {"max": 7.5, "min": 5, "name": "pH Determination"}, {"max": 110, "min": 100, "name": "Deliverable Volume (mL)"}, {"max": 100, "min": 0, "name": "Total Aerobic Microbial Count (CFU/g)"}]');
INSERT INTO public.specifications (id, material, version, effective_date, status, parameters) VALUES ('SPEC-CIPRO-500', 'Ciprofloxacin 500mg Film-Coated Tablets', 1, '2026-01-01', 'Active', '[{"max": 102, "min": 98, "name": "HPLC Assay (% Label Claim)"}, {"max": 100, "min": 80, "name": "Dissolution (Q at 30 min, %)"}, {"max": 0.2, "min": 0, "name": "Fluoroquinolonic Acid Impurity (%)"}]');


--
-- Data for Name: stability_studies; Type: TABLE DATA; Schema: public; Owner: lims
--



--
-- Data for Name: system_settings; Type: TABLE DATA; Schema: public; Owner: lims
--

INSERT INTO public.system_settings (id, session_timeout_minutes, max_failed_logins, password_expiry_days, min_password_length, require_uppercase, require_numbers, require_symbols, updated_at) VALUES ('default', 20, 3, 90, 8, true, true, true, '2026-10-13 13:16:52.282');


--
-- Data for Name: training_records; Type: TABLE DATA; Schema: public; Owner: lims
--

INSERT INTO public.training_records (id, user_id, module_name, status, completed_at, certified_by, version) VALUES ('TRN-001', 'usr-analyst1', '21 CFR Part 11 & Data Integrity', 'Completed', '2026-08-29 13:15:53.663', 'usr-qa', 1);
INSERT INTO public.training_records (id, user_id, module_name, status, completed_at, certified_by, version) VALUES ('TRN-002', 'usr-analyst1', 'HPLC Chromatography SOP (USP <621>)', 'Completed', '2026-09-13 13:15:53.663', 'usr-qa', 1);
INSERT INTO public.training_records (id, user_id, module_name, status, completed_at, certified_by, version) VALUES ('TRN-003', 'usr-analyst1', 'Cleanroom Aseptic Gowning (ISO 14644)', 'Overdue', NULL, NULL, 1);
INSERT INTO public.training_records (id, user_id, module_name, status, completed_at, certified_by, version) VALUES ('TRN-004', 'usr-analyst2', '21 CFR Part 11 & Data Integrity', 'Completed', '2026-08-14 13:15:53.663', 'usr-qa', 1);
INSERT INTO public.training_records (id, user_id, module_name, status, completed_at, certified_by, version) VALUES ('TRN-005', 'usr-analyst2', 'Dissolution Testing Protocol (USP <711>)', 'Overdue', NULL, NULL, 1);
INSERT INTO public.training_records (id, user_id, module_name, status, completed_at, certified_by, version) VALUES ('TRN-006', 'usr-analyst2', 'OOS / OOT Investigation Procedure', 'Pending', NULL, NULL, 1);
INSERT INTO public.training_records (id, user_id, module_name, status, completed_at, certified_by, version) VALUES ('TRN-007', 'usr-reviewer', 'Data Integrity & Audit Trail Review', 'Completed', '2026-09-23 13:15:53.663', 'usr-qa', 1);
INSERT INTO public.training_records (id, user_id, module_name, status, completed_at, certified_by, version) VALUES ('TRN-008', 'usr-reviewer', 'Computerized System Validation (GAMP 5)', 'Overdue', NULL, NULL, 1);
INSERT INTO public.training_records (id, user_id, module_name, status, completed_at, certified_by, version) VALUES ('TRN-009', 'usr-qa', 'Batch Record Review & QP Release', 'Completed', '2026-10-03 13:15:53.663', 'usr-admin', 1);
INSERT INTO public.training_records (id, user_id, module_name, status, completed_at, certified_by, version) VALUES ('TRN-010', 'usr-qa', 'Quality Risk Management (ICH Q9)', 'Completed', '2026-10-08 13:15:53.663', 'usr-admin', 1);


--
-- PostgreSQL database dump complete
--
