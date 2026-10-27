export interface Location {
  name: string;
  displayName: string;
  regionalDisplayName: string;
  geography: string;
  physicalLocation: string;
  latitude: string;
  longitude: string;
  pairedRegion?: string;
}

const L = (name: string, displayName: string, geography: string, physicalLocation: string, latitude: string, longitude: string, pairedRegion?: string): Location => ({
  name, displayName, regionalDisplayName: `(${geography}) ${displayName}`, geography, physicalLocation, latitude, longitude, pairedRegion,
});

export const LOCATIONS: Location[] = [
  L('italynorth', 'Italy North', 'Europe', 'Milan', '45.46888', '9.18109'),
  L('westeurope', 'West Europe', 'Europe', 'Netherlands', '52.3667', '4.9', 'northeurope'),
  L('northeurope', 'North Europe', 'Europe', 'Ireland', '53.3478', '-6.2597', 'westeurope'),
  L('francecentral', 'France Central', 'Europe', 'Paris', '46.3772', '2.3730', 'francesouth'),
  L('germanywestcentral', 'Germany West Central', 'Europe', 'Frankfurt', '50.110924', '8.682127', 'germanynorth'),
  L('switzerlandnorth', 'Switzerland North', 'Europe', 'Zurich', '47.451542', '8.564572', 'switzerlandwest'),
  L('swedencentral', 'Sweden Central', 'Europe', 'Gävle', '60.67488', '17.14127', 'swedensouth'),
  L('norwayeast', 'Norway East', 'Europe', 'Norway', '59.913868', '10.752245', 'norwaywest'),
  L('polandcentral', 'Poland Central', 'Europe', 'Warsaw', '52.23334', '21.01666'),
  L('spaincentral', 'Spain Central', 'Europe', 'Madrid', '40.4259', '-3.4209'),
  L('uksouth', 'UK South', 'Europe', 'London', '50.941', '-0.799', 'ukwest'),
  L('ukwest', 'UK West', 'Europe', 'Cardiff', '53.427', '-3.084', 'uksouth'),
  L('eastus', 'East US', 'US', 'Virginia', '37.3719', '-79.8164', 'westus'),
  L('eastus2', 'East US 2', 'US', 'Virginia', '36.6681', '-78.3889', 'centralus'),
  L('centralus', 'Central US', 'US', 'Iowa', '41.5908', '-93.6208', 'eastus2'),
  L('southcentralus', 'South Central US', 'US', 'Texas', '29.4167', '-98.5', 'northcentralus'),
  L('westus', 'West US', 'US', 'California', '37.783', '-122.417', 'eastus'),
  L('westus2', 'West US 2', 'US', 'Washington', '47.233', '-119.852', 'westcentralus'),
  L('westus3', 'West US 3', 'US', 'Phoenix', '33.448376', '-112.074036', 'eastus'),
  L('canadacentral', 'Canada Central', 'Canada', 'Toronto', '43.653', '-79.383', 'canadaeast'),
  L('brazilsouth', 'Brazil South', 'South America', 'Sao Paulo State', '-23.55', '-46.633', 'southcentralus'),
  L('japaneast', 'Japan East', 'Asia Pacific', 'Tokyo, Saitama', '35.68', '139.77', 'japanwest'),
  L('koreacentral', 'Korea Central', 'Asia Pacific', 'Seoul', '37.5665', '126.9780', 'koreasouth'),
  L('southeastasia', 'Southeast Asia', 'Asia Pacific', 'Singapore', '1.283', '103.833', 'eastasia'),
  L('eastasia', 'East Asia', 'Asia Pacific', 'Hong Kong', '22.267', '114.188', 'southeastasia'),
  L('centralindia', 'Central India', 'Asia Pacific', 'Pune', '18.5822', '73.9197', 'southindia'),
  L('australiaeast', 'Australia East', 'Asia Pacific', 'New South Wales', '-33.86', '151.2094', 'australiasoutheast'),
  L('uaenorth', 'UAE North', 'Middle East', 'Dubai', '25.266666', '55.316666', 'uaecentral'),
  L('southafricanorth', 'South Africa North', 'Africa', 'Johannesburg', '-25.731340', '28.218370', 'southafricawest'),
];

const byName = new Map(LOCATIONS.map((l) => [l.name, l]));

export function normalizeLocation(loc: unknown): string | null {
  if (typeof loc !== 'string') return null;
  const n = loc.toLowerCase().replace(/\s+/g, '');
  if (n === 'global') return 'global';
  return byName.has(n) ? n : null;
}

export function locationDisplay(name: string): string {
  return byName.get(name)?.displayName ?? name;
}

export function locationResource(sub: string, l: Location) {
  return {
    id: `/subscriptions/${sub}/locations/${l.name}`,
    name: l.name,
    type: 'Region',
    displayName: l.displayName,
    regionalDisplayName: l.regionalDisplayName,
    metadata: {
      regionType: 'Physical',
      regionCategory: 'Recommended',
      geography: l.geography,
      geographyGroup: l.geography,
      longitude: l.longitude,
      latitude: l.latitude,
      physicalLocation: l.physicalLocation,
      pairedRegion: l.pairedRegion ? [{ name: l.pairedRegion, id: `/subscriptions/${sub}/locations/${l.pairedRegion}` }] : [],
    },
    availabilityZoneMappings: ['1', '2', '3'].map((z) => ({ logicalZone: z, physicalZone: `${l.name}-az${z}` })),
  };
}
