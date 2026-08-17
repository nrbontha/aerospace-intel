-- Demo catalog for limited-availability walkthroughs.
-- Idempotent on legal_name / capability code / platform name / part number.
-- Does not assert sole-source, certification validity, or platform eligibility.
-- Qualification scarcity stays not_assessed; certificate numbers are omitted.

begin;

with company_seed (
  legal_name,
  display_name,
  description,
  headquarters_country_code,
  website_url,
  founded_year
) as (
  values
    (
      'Hitchiner Manufacturing Co., Inc.',
      'Hitchiner',
      'Investment casting manufacturer. Demo catalog row for public walkthroughs; not an operational qualification record.',
      'US',
      'https://www.hitchiner.com/',
      1946
    ),
    (
      'Howmet Aerospace Inc.',
      'Howmet Aerospace',
      'Engineered metal products for aerospace. Demo catalog row for public walkthroughs.',
      'US',
      'https://www.howmet.com/',
      1888
    ),
    (
      'Precision Castparts Corp.',
      'Precision Castparts',
      'Investment castings, forgings, and fasteners. Demo catalog row for public walkthroughs.',
      'US',
      'https://www.precast.com/',
      1949
    ),
    (
      'Spirit AeroSystems Holdings, Inc.',
      'Spirit AeroSystems',
      'Aerostructures manufacturer. Demo catalog row for public walkthroughs.',
      'US',
      'https://www.spiritaero.com/',
      2005
    ),
    (
      'Triumph Group, Inc.',
      'Triumph Group',
      'Aerospace systems and structures. Demo catalog row for public walkthroughs.',
      'US',
      'https://www.triumphgroup.com/',
      1993
    ),
    (
      'Moog Inc.',
      'Moog',
      'Motion control and actuation. Demo catalog row for public walkthroughs.',
      'US',
      'https://www.moog.com/',
      1951
    ),
    (
      'Parker-Hannifin Corporation',
      'Parker',
      'Motion and control technologies including aerospace systems. Demo catalog row for public walkthroughs.',
      'US',
      'https://www.parker.com/',
      1917
    ),
    (
      'Barnes Group Inc.',
      'Barnes',
      'Aerospace aftermarket and manufacturing. Demo catalog row for public walkthroughs.',
      'US',
      'https://www.barnesgroupinc.com/',
      1857
    ),
    (
      'The Boeing Company',
      'Boeing',
      'Airframer used as a demo customer. Presence here does not imply a contractual relationship.',
      'US',
      'https://www.boeing.com/',
      1916
    ),
    (
      'Lockheed Martin Corporation',
      'Lockheed Martin',
      'Airframer used as a demo customer. Presence here does not imply a contractual relationship.',
      'US',
      'https://www.lockheedmartin.com/',
      1995
    ),
    (
      'RTX Corporation',
      'RTX',
      'Aerospace and defense OEM used as a demo customer.',
      'US',
      'https://www.rtx.com/',
      2020
    ),
    (
      'GE Aerospace',
      'GE Aerospace',
      'Aircraft engine OEM used as a demo customer.',
      'US',
      'https://www.geaerospace.com/',
      1917
    ),
    (
      'Northrop Grumman Corporation',
      'Northrop Grumman',
      'Airframer used as a demo customer.',
      'US',
      'https://www.northropgrumman.com/',
      1994
    )
)
insert into companies (
  legal_name,
  display_name,
  description,
  headquarters_country_code,
  website_url,
  founded_year
)
select
  s.legal_name,
  s.display_name,
  s.description,
  s.headquarters_country_code,
  s.website_url,
  s.founded_year
from company_seed s
where not exists (
  select 1
  from companies c
  where lower(c.legal_name) = lower(s.legal_name)
);

insert into company_aliases (company_id, alias, alias_type, is_primary)
select c.id, seed.alias, seed.alias_type, false
from (
  values
    ('Hitchiner Manufacturing Co., Inc.', 'HMC', 'abbreviation'),
    ('Precision Castparts Corp.', 'PCC', 'abbreviation'),
    ('Spirit AeroSystems Holdings, Inc.', 'Spirit', 'trade'),
    ('Lockheed Martin Corporation', 'LM', 'abbreviation'),
    ('The Boeing Company', 'Boeing', 'trade'),
    ('GE Aerospace', 'GE', 'abbreviation')
) as seed(legal_name, alias, alias_type)
join companies c on lower(c.legal_name) = lower(seed.legal_name)
where not exists (
  select 1
  from company_aliases a
  where a.company_id = c.id
    and lower(a.alias) = lower(seed.alias)
);

insert into company_domains (company_id, domain, is_primary)
select c.id, seed.domain, true
from (
  values
    ('Hitchiner Manufacturing Co., Inc.', 'hitchiner.com'),
    ('Howmet Aerospace Inc.', 'howmet.com'),
    ('Precision Castparts Corp.', 'precast.com'),
    ('Spirit AeroSystems Holdings, Inc.', 'spiritaero.com'),
    ('Triumph Group, Inc.', 'triumphgroup.com'),
    ('Moog Inc.', 'moog.com'),
    ('Parker-Hannifin Corporation', 'parker.com'),
    ('Barnes Group Inc.', 'barnesgroupinc.com'),
    ('The Boeing Company', 'boeing.com'),
    ('Lockheed Martin Corporation', 'lockheedmartin.com'),
    ('RTX Corporation', 'rtx.com'),
    ('GE Aerospace', 'geaerospace.com'),
    ('Northrop Grumman Corporation', 'northropgrumman.com')
) as seed(legal_name, domain)
join companies c on lower(c.legal_name) = lower(seed.legal_name)
where not exists (
  select 1
  from company_domains d
  where lower(d.domain) = lower(seed.domain)
);

insert into capabilities (code, name, description)
select seed.code, seed.name, seed.description
from (
  values
    ('CAST-INV', 'Investment casting', 'Countergravity and conventional investment casting.'),
    ('MACH-CNC', 'CNC machining', 'Precision machining of aerospace metals.'),
    ('FORGE', 'Closed-die forging', 'Structural and rotating-part forgings.'),
    ('HT', 'Heat treatment', 'Controlled-atmosphere heat treatment.'),
    ('NDT', 'Nondestructive testing', 'Inspection methods such as FPI, UT, and radiography.'),
    ('ASM', 'Aerostructures assembly', 'Major airframe assembly and integration.'),
    ('ADD', 'Additive manufacturing', 'Metal additive processes for aerospace parts.'),
    ('ACT', 'Flight actuation', 'Primary and secondary flight control actuation.')
) as seed(code, name, description)
where not exists (
  select 1 from capabilities c where c.code = seed.code
);

insert into company_capabilities (company_id, capability_id, status, confidence)
select c.id, cap.id, 'active', 0.7000
from (
  values
    ('Hitchiner Manufacturing Co., Inc.', 'CAST-INV'),
    ('Hitchiner Manufacturing Co., Inc.', 'HT'),
    ('Hitchiner Manufacturing Co., Inc.', 'NDT'),
    ('Howmet Aerospace Inc.', 'CAST-INV'),
    ('Howmet Aerospace Inc.', 'FORGE'),
    ('Howmet Aerospace Inc.', 'HT'),
    ('Precision Castparts Corp.', 'CAST-INV'),
    ('Precision Castparts Corp.', 'FORGE'),
    ('Spirit AeroSystems Holdings, Inc.', 'ASM'),
    ('Spirit AeroSystems Holdings, Inc.', 'MACH-CNC'),
    ('Triumph Group, Inc.', 'ASM'),
    ('Triumph Group, Inc.', 'MACH-CNC'),
    ('Moog Inc.', 'ACT'),
    ('Moog Inc.', 'MACH-CNC'),
    ('Parker-Hannifin Corporation', 'ACT'),
    ('Barnes Group Inc.', 'MACH-CNC'),
    ('Barnes Group Inc.', 'ADD')
) as seed(legal_name, code)
join companies c on lower(c.legal_name) = lower(seed.legal_name)
join capabilities cap on cap.code = seed.code
where not exists (
  select 1
  from company_capabilities cc
  where cc.company_id = c.id
    and cc.capability_id = cap.id
);

insert into facilities (
  company_id,
  name,
  facility_type,
  city,
  region,
  country_code,
  status
)
select c.id, seed.name, seed.facility_type, seed.city, seed.region, seed.country_code, 'active'
from (
  values
    ('Hitchiner Manufacturing Co., Inc.', 'Milford', 'foundry', 'Milford', 'NH', 'US'),
    ('Howmet Aerospace Inc.', 'Whitehall', 'foundry', 'Whitehall', 'MI', 'US'),
    ('Precision Castparts Corp.', 'Portland', 'foundry', 'Portland', 'OR', 'US'),
    ('Spirit AeroSystems Holdings, Inc.', 'Wichita', 'aerostructures', 'Wichita', 'KS', 'US'),
    ('Triumph Group, Inc.', 'Forest', 'manufacturing', 'Forest', 'OH', 'US'),
    ('Moog Inc.', 'East Aurora', 'manufacturing', 'East Aurora', 'NY', 'US'),
    ('Parker-Hannifin Corporation', 'Irvine', 'manufacturing', 'Irvine', 'CA', 'US'),
    ('Barnes Group Inc.', 'Windsor', 'manufacturing', 'Windsor', 'CT', 'US')
) as seed(legal_name, name, facility_type, city, region, country_code)
join companies c on lower(c.legal_name) = lower(seed.legal_name)
where not exists (
  select 1
  from facilities f
  where f.company_id = c.id
    and lower(f.name) = lower(seed.name)
);

insert into facility_capabilities (facility_id, capability_id, status, confidence)
select f.id, cap.id, 'active', 0.7000
from (
  values
    ('Hitchiner Manufacturing Co., Inc.', 'Milford', 'CAST-INV'),
    ('Hitchiner Manufacturing Co., Inc.', 'Milford', 'HT'),
    ('Howmet Aerospace Inc.', 'Whitehall', 'CAST-INV'),
    ('Precision Castparts Corp.', 'Portland', 'FORGE'),
    ('Spirit AeroSystems Holdings, Inc.', 'Wichita', 'ASM'),
    ('Moog Inc.', 'East Aurora', 'ACT')
) as seed(legal_name, facility_name, code)
join companies c on lower(c.legal_name) = lower(seed.legal_name)
join facilities f
  on f.company_id = c.id
 and lower(f.name) = lower(seed.facility_name)
join capabilities cap on cap.code = seed.code
where not exists (
  select 1
  from facility_capabilities fc
  where fc.facility_id = f.id
    and fc.capability_id = cap.id
);

insert into certifications (company_id, facility_id, standard, issuing_body, status)
select c.id, null, seed.standard, seed.issuing_body, 'active'
from (
  values
    ('Hitchiner Manufacturing Co., Inc.', 'AS9100', 'SAE'),
    ('Howmet Aerospace Inc.', 'AS9100', 'SAE'),
    ('Precision Castparts Corp.', 'AS9100', 'SAE'),
    ('Spirit AeroSystems Holdings, Inc.', 'AS9100', 'SAE'),
    ('Moog Inc.', 'AS9100', 'SAE')
) as seed(legal_name, standard, issuing_body)
join companies c on lower(c.legal_name) = lower(seed.legal_name)
where not exists (
  select 1
  from certifications cert
  where cert.company_id = c.id
    and cert.facility_id is null
    and cert.standard = seed.standard
    and cert.certificate_number is null
);

insert into platform_families (name, manufacturer_company_id, description)
select seed.name, c.id, seed.description
from (
  values
    ('F-35 Lightning II', 'Lockheed Martin Corporation', 'Multirole fighter family.'),
    ('F-16 Fighting Falcon', 'Lockheed Martin Corporation', 'Multirole fighter family.'),
    ('787 Dreamliner', 'The Boeing Company', 'Twin-aisle commercial family.'),
    ('737', 'The Boeing Company', 'Single-aisle commercial family.'),
    ('C-130 Hercules', 'Lockheed Martin Corporation', 'Tactical airlift family.')
) as seed(name, manufacturer, description)
join companies c on lower(c.legal_name) = lower(seed.manufacturer)
where not exists (
  select 1
  from platform_families pf
  where lower(pf.name) = lower(seed.name)
    and pf.manufacturer_company_id = c.id
);

insert into platforms (family_id, name, platform_type, manufacturer_company_id, description)
select pf.id, seed.name, seed.platform_type, c.id, seed.description
from (
  values
    ('F-35 Lightning II', 'F-35 Lightning II', 'fighter', 'Lockheed Martin Corporation', 'Conventional, STOVL, and carrier variants.'),
    ('F-16 Fighting Falcon', 'F-16 Fighting Falcon', 'fighter', 'Lockheed Martin Corporation', 'Multirole fighter.'),
    ('787 Dreamliner', '787-9 Dreamliner', 'commercial_transport', 'The Boeing Company', 'Long-range twin-aisle.'),
    ('737', '737 MAX 8', 'commercial_transport', 'The Boeing Company', 'Single-aisle commercial.'),
    ('C-130 Hercules', 'C-130J Super Hercules', 'airlift', 'Lockheed Martin Corporation', 'Tactical airlift.')
) as seed(family_name, name, platform_type, manufacturer, description)
join companies c on lower(c.legal_name) = lower(seed.manufacturer)
join platform_families pf
  on lower(pf.name) = lower(seed.family_name)
 and pf.manufacturer_company_id = c.id
where not exists (
  select 1
  from platforms p
  where lower(p.name) = lower(seed.name)
    and p.manufacturer_company_id = c.id
);

insert into subsystems (code, name, description)
select seed.code, seed.name, seed.description
from (
  values
    ('STRUCT', 'Airframe structure', 'Primary and secondary structure.'),
    ('PROP', 'Propulsion', 'Engine and related hardware.'),
    ('FCS', 'Flight controls', 'Actuation and control surfaces.')
) as seed(code, name, description)
where not exists (
  select 1 from subsystems s where s.code = seed.code
);

insert into parts (manufacturer_company_id, part_number, name, description, lifecycle_status)
select c.id, seed.part_number, seed.name, seed.description, 'active'
from (
  values
    ('Hitchiner Manufacturing Co., Inc.', 'HMC-INV-STRUCT-001', 'Structural investment casting', 'Demo part number for catalog walkthroughs.'),
    ('Howmet Aerospace Inc.', 'HA-FAN-BLADE-001', 'Fan blade forging', 'Demo part number for catalog walkthroughs.'),
    ('Precision Castparts Corp.', 'PCC-STRUCT-CAST-001', 'Structural casting', 'Demo part number for catalog walkthroughs.'),
    ('Spirit AeroSystems Holdings, Inc.', 'SPIRIT-787-FUSE-001', '787 fuselage section', 'Demo part number for catalog walkthroughs.'),
    ('Moog Inc.', 'MOOG-ACT-001', 'Flight control actuator', 'Demo part number for catalog walkthroughs.')
) as seed(legal_name, part_number, name, description)
join companies c on lower(c.legal_name) = lower(seed.legal_name)
where not exists (
  select 1
  from parts p
  where upper(p.part_number) = upper(seed.part_number)
    and p.manufacturer_company_id = c.id
);

insert into facility_qualifications (
  facility_id,
  part_id,
  platform_id,
  subsystem_id,
  customer_company_id,
  qualification_reference,
  scarcity,
  confidence
)
select
  f.id,
  p.id,
  pl.id,
  sub.id,
  cust.id,
  'Demo catalog context — review before operational use',
  'not_assessed',
  0.5000
from (
  values
    (
      'Hitchiner Manufacturing Co., Inc.',
      'Milford',
      'HMC-INV-STRUCT-001',
      'F-35 Lightning II',
      'STRUCT',
      'Lockheed Martin Corporation'
    ),
    (
      'Spirit AeroSystems Holdings, Inc.',
      'Wichita',
      'SPIRIT-787-FUSE-001',
      '787-9 Dreamliner',
      'STRUCT',
      'The Boeing Company'
    ),
    (
      'Howmet Aerospace Inc.',
      'Whitehall',
      'HA-FAN-BLADE-001',
      'F-35 Lightning II',
      'PROP',
      'Lockheed Martin Corporation'
    ),
    (
      'Moog Inc.',
      'East Aurora',
      'MOOG-ACT-001',
      'F-16 Fighting Falcon',
      'FCS',
      'Lockheed Martin Corporation'
    ),
    (
      'Precision Castparts Corp.',
      'Portland',
      'PCC-STRUCT-CAST-001',
      '737 MAX 8',
      'STRUCT',
      'The Boeing Company'
    )
) as seed(supplier, facility_name, part_number, platform_name, subsystem_code, customer)
join companies supplier on lower(supplier.legal_name) = lower(seed.supplier)
join facilities f
  on f.company_id = supplier.id
 and lower(f.name) = lower(seed.facility_name)
join parts p
  on p.manufacturer_company_id = supplier.id
 and upper(p.part_number) = upper(seed.part_number)
join platforms pl on lower(pl.name) = lower(seed.platform_name)
join subsystems sub on sub.code = seed.subsystem_code
join companies cust on lower(cust.legal_name) = lower(seed.customer)
where not exists (
  select 1
  from facility_qualifications q
  where q.facility_id = f.id
    and q.part_id = p.id
    and q.platform_id is not distinct from pl.id
    and q.platform_variant_id is null
    and q.subsystem_id is not distinct from sub.id
    and q.customer_company_id is not distinct from cust.id
    and q.valid_from is null
);

insert into data_sources (
  name,
  source_type,
  base_url,
  access,
  ingestion,
  publisher,
  notes
)
select
  seed.name,
  'company_website',
  seed.base_url,
  'public',
  'web_fetch',
  seed.publisher,
  'Demo catalog source. Public website only.'
from (
  values
    ('Hitchiner Manufacturing Company website', 'https://www.hitchiner.com/', 'Hitchiner Manufacturing Co., Inc.'),
    ('Howmet Aerospace website', 'https://www.howmet.com/', 'Howmet Aerospace Inc.'),
    ('Precision Castparts website', 'https://www.precast.com/', 'Precision Castparts Corp.'),
    ('Spirit AeroSystems website', 'https://www.spiritaero.com/', 'Spirit AeroSystems Holdings, Inc.'),
    ('Moog website', 'https://www.moog.com/', 'Moog Inc.')
) as seed(name, base_url, publisher)
where not exists (
  select 1
  from data_sources ds
  where lower(ds.name) = lower(seed.name)
    and coalesce(ds.publisher, '') = seed.publisher
);

insert into company_source_links (data_source_id, company_id, relationship)
select ds.id, c.id, 'subject'
from (
  values
    ('Hitchiner Manufacturing Company website', 'Hitchiner Manufacturing Co., Inc.'),
    ('Howmet Aerospace website', 'Howmet Aerospace Inc.'),
    ('Precision Castparts website', 'Precision Castparts Corp.'),
    ('Spirit AeroSystems website', 'Spirit AeroSystems Holdings, Inc.'),
    ('Moog website', 'Moog Inc.')
) as seed(source_name, legal_name)
join data_sources ds on lower(ds.name) = lower(seed.source_name)
join companies c on lower(c.legal_name) = lower(seed.legal_name)
where not exists (
  select 1
  from company_source_links l
  where l.data_source_id = ds.id
    and l.company_id = c.id
    and l.relationship = 'subject'
);

commit;

select
  (select count(*) from companies) as companies,
  (select count(*) from facilities) as facilities,
  (select count(*) from capabilities) as capabilities,
  (select count(*) from certifications) as certifications,
  (select count(*) from platforms) as platforms,
  (select count(*) from parts) as parts,
  (select count(*) from facility_qualifications) as qualifications,
  (select count(*) from data_sources) as data_sources;
