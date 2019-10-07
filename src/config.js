const defaultConfig = {
  poiTypeTags: [
    'leisure',
    'amenity',
    'shop',
    'craft',
    'zoo',
    'office',
    'club',
    'man_made',
    'natural',
    'tourism',
    'public_transport'
  ],
  pathTypes: [
    'motorway',
    'trunk',
    'primary',
    'secondary',
    'tertiary',
    'residential',
    'service',
    'motorway_link',
    'trunk_link',
    'primary_link',
    'secondary_link',
    'tertiary_link'
  ],
  leisureTypes: [
    'adult_gaming_centre',
    'amusement_arcade',
    'beach_resort',
    'bowling_alley',
    'common',
    'dance',
    'disc_golf_course',
    'dog_park',
    'escape_game',
    'fishing',
    'fitness_centre',
    'garden',
    'golf_course',
    'hackerspace',
    'horse_riding',
    'ice_rink',
    'marina',
    'miniature_golf',
    'nature_reserve',
    'park',
    'pitch',
    'playground',
    'sauna',
    'sports_centre',
    'stadium',
    'summer_camp',
    'swimming_area',
    'swimming_pool',
    'track',
    'water_park'
  ],
  manMadeTypes: [
    'bridge',
    'communications_tower',
    'crane',
    'cross',
    'dyke',
    'lighthouse',
    'maypole',
    'obelisk',
    'observatory',
    'offshore_platform',
    'pier',
    'telescope',
    'windmill',
    'works'
  ],
}

function createConfig(userConfig) {
  return Object.assign({}, defaultConfig, userConfig);
}

module.exports = createConfig;
