// (A72: hand-built town buildings. One entry per building, set by eye from its Street View photo.
// Key: footprint centroid, lat,lon x 1e5, as TOWN_PIERS. Fields: roof gable|hip|flat, rise and eave in metres,
// wall/roofColor/trim/awning as 0xRRGGBB (awning 0: none), style the wall pattern (props.js), front the shopfront bearing.)
export const TOWN_HAND = new Map(Object.entries({
  // Miller Avenue at Montford, mv2_591600_f and mv2_591700_f
  "3789765,-12253666": { roof: 'gable', rise: 2.2, eave: 4.6, wall: 0x8e9a96, roofColor: 0x6e3a30, style: 5, trim: 0x3e3a34, front: 228, awning: 0 },  // sage clapboard shop, dark trim, maroon roof
  "3789778,-12253693": { roof: 'hip', rise: 1.2, eave: 3.8, wall: 0xe9e6dd, roofColor: 0x6b665e },  // low white building in the trees
  "3789795,-12253714": { roof: 'hip', rise: 1.0, eave: 3.6, wall: 0xe4e0d4, roofColor: 0x66625b },
  "3789814,-12253733": { roof: 'hip', rise: 1.2, eave: 3.8, wall: 0xd8cdb8, roofColor: 0x66625b },
  "3789824,-12253743": { roof: 'hip', rise: 1.4, eave: 3.6, wall: 0x7a5a44, roofColor: 0x9a4a33, style: 5, trim: 0x3e3028, front: 228, awning: 0 },  // brown timber shop under red tile, mv2_591700_f right
  "3789827,-12253752": { roof: 'hip', rise: 1.4, eave: 3.6, wall: 0x7a5a44, roofColor: 0x9a4a33, style: 5, trim: 0x3e3028, front: 229, awning: 0 },
  "3789832,-12253744": { roof: 'hip', rise: 1.0, eave: 3.4, wall: 0x7a5a44, roofColor: 0x9a4a33, style: 5 },
  "3789838,-12253724": { roof: 'hip', rise: 1.2, eave: 3.8, wall: 0xe3ddd0, roofColor: 0x66625b },
  "3789856,-12253763": { roof: 'flat', eave: 4.2, wall: 0xe6e1d4 },
  "3789862,-12253785": { roof: 'flat', eave: 4.4, wall: 0xdcd6c8, front: 229, trim: 0x4a4038, awning: 0 },
  "3789752,-12253753": { roof: 'flat', eave: 4.2, wall: 0xf1efe8, trim: 0x8a2f2a, front: 48, awning: 0 },  // white low shop, red sign band, mv2_591600_f left
  "3789771,-12253779": { roof: 'hip', rise: 1.3, eave: 4.8, wall: 0x9fae8c, roofColor: 0x5c5a55, style: 5 },  // sage two-storey behind
  "3789816,-12253819": { roof: 'flat', eave: 3.8, wall: 0xf2f0ea, trim: 0x2f5fa8 },  // white low building with blue band, mv2_591700_f left
  "3789822,-12253832": { roof: 'flat', eave: 3.8, wall: 0xf2f0ea, trim: 0x2f5fa8, front: 47, awning: 0 },
  "3789835,-12253848": { roof: 'flat', eave: 3.8, wall: 0xeeece6 },
  "3789827,-12253872": { roof: 'hip', rise: 1.4, wall: 0xf0eee8, roofColor: 0x5c5a55 },  // white hillside house with a deck
  // Miller Avenue, Sycamore to Lytton Square: mv2_591800_f to mv2_593000_f (most of this stretch is behind its redwoods and oaks)
  "3789881,-12253895": { roof: 'gable', rise: 3.2, eave: 5.6, wall: 0xf1eee6, roofColor: 0x55534f },  // white two-storey house, dark gable
  "3789916,-12253849": { roof: 'hip', rise: 1.4, eave: 4.2, wall: 0xd9cdb6, roofColor: 0x66625b },
  "3789937,-12253887": { roof: 'hip', rise: 1.6, eave: 5.4, wall: 0xd99a62, roofColor: 0x9a4a33, front: 227, trim: 0x5a4030, awning: 0 },  // orange stucco under red tile
  "3789950,-12253833": { roof: 'hip', rise: 1.5, eave: 4.4, wall: 0xd8ccb4, roofColor: 0x66625b },
  "3789901,-12253915": { roof: 'flat', eave: 4.0, wall: 0xe6e0d4, front: 46, trim: 0x4a4038, awning: 0 },
  "3789976,-12253897": { roof: 'gable', rise: 2.0, eave: 3.4, wall: 0x8a5a3c, roofColor: 0x6b665e, style: 5, front: 227, trim: 0x5a3a2a, awning: 0 },  // brown shingle bungalow on a brick base
  "3789976,-12253912": { roof: 'gable', rise: 2.0, eave: 3.4, wall: 0x8a5a3c, roofColor: 0x6b665e, style: 5, front: 229, trim: 0x5a3a2a, awning: 0 },
  "3789993,-12253928": { roof: 'gable', rise: 2.4, eave: 3.8, wall: 0x9a6a48, roofColor: 0x6b665e, style: 5 },
  "3789948,-12253972": { roof: 'flat', eave: 4.0, wall: 0xe4e2dc, front: 48, trim: 0x4a4a48, awning: 0 },  // low grey-white block on its car park
  "3790018,-12254061": { roof: 'hip', rise: 1.6, eave: 3.6, wall: 0xeee8d8, roofColor: 0x5c5a55 },  // cream houses behind the car park
  "3790028,-12254075": { roof: 'hip', rise: 1.6, eave: 3.6, wall: 0xeee8d8, roofColor: 0x5c5a55 },
  "3790036,-12253979": { roof: 'gable', rise: 2.6, eave: 4.0, wall: 0x6e5040, roofColor: 0x55534f, style: 5, front: 229, awning: 0 },  // dark timber under the trees
  "3790046,-12253989": { roof: 'gable', rise: 2.4, eave: 4.0, wall: 0x6e5040, roofColor: 0x55534f, style: 5, front: 227, awning: 0 },
  "3790056,-12254008": { roof: 'gable', rise: 2.0, eave: 4.0, wall: 0x7c5c44, roofColor: 0x55534f, style: 5, front: 230, awning: 0 },
  "3790385,-12254472": { roof: 'gable', rise: 2.2, eave: 3.4, wall: 0x8c3a2e, roofColor: 0x5c5a55, style: 5 },  // red clapboard, grey shingle gable, mv2_592600_f
  // Lytton Square approach, mv2_593000_f: cream stucco with arches, red tile
  "3790566,-12254831": { roof: 'hip', rise: 1.5, eave: 6.4, wall: 0xe9dcc0, roofColor: 0x9a4a33, front: 55, trim: 0x4a3a30, awning: 0 },
  "3790580,-12254837": { roof: 'hip', rise: 1.5, eave: 6.4, wall: 0xe9dcc0, roofColor: 0x9a4a33 },
  "3790590,-12254848": { roof: 'hip', rise: 1.2, eave: 6.4, wall: 0xe4d6bc, roofColor: 0x9a4a33, front: 317, trim: 0x4a3a30, awning: 0 },
  "3790620,-12254798": { roof: 'hip', rise: 1.8, eave: 6.0, wall: 0xeee6d6, roofColor: 0x9a4a33, front: 324, trim: 0x4a3a30, awning: 0 },
  "3790623,-12254862": { roof: 'hip', rise: 1.4, eave: 6.8, wall: 0xf0ead8, roofColor: 0x9a4a33 },
  "3790630,-12254858": { roof: 'hip', rise: 1.6, eave: 6.8, wall: 0xf3efe6, roofColor: 0x9a4a33, front: 91, trim: 0x4a3a30, awning: 0 },
  "3790620,-12254870": { roof: 'hip', rise: 1.4, eave: 6.6, wall: 0xece2cc, roofColor: 0x9a4a33, front: 140, trim: 0x4a3a30, awning: 0 },
  "3790614,-12254876": { roof: 'hip', rise: 1.4, eave: 6.6, wall: 0xf0ead8, roofColor: 0x9a4a33, front: 139, trim: 0x4a3a30, awning: 0 },
  "3790611,-12254889": { roof: 'hip', rise: 1.2, eave: 6.6, wall: 0xe6dac2, roofColor: 0x9a4a33, front: 140, trim: 0x4a3a30, awning: 0 },
  // Bridgeway at the Spinnaker, cxs_540900_0
  "3785298,-12247915": { roof: 'flat', eave: 10, wall: 0xeeebe4 },  // white modern stucco, three storeys, timber-framed glass
  "3785310,-12247916": { roof: 'flat', eave: 10, wall: 0xeeebe4 },
  "3785319,-12247914": { roof: 'flat', eave: 9, wall: 0x8d8f8f },  // grey three-storey box
  "3785330,-12247915": { roof: 'flat', eave: 9, wall: 0x9aa29a, style: 4, face: 90, balconies: 0x8e948e },  // grey-green 1960s flats with long balconies, svs_540950_L
  "3785341,-12247918": { roof: 'flat', eave: 9.5, wall: 0xc8c8d4, face: 90, bays: 1 },  // lavender-grey bay-windowed flats
  "3785365,-12247921": { roof: 'flat', eave: 9, wall: 0xeeece6, face: 90, balconies: 0xe8e6e0 },  // white, balconies over the plaza, svs_541000_L
  "3785374,-12247921": { roof: 'flat', eave: 7.4, wall: 0xc9d3bf, face: 90, bays: 1 },  // sage Edwardian with bays, the bakery's green shopfront
  "3785387,-12247918": { roof: 'flat', eave: 7.4, wall: 0xc9d3bf, face: 90, bays: 1 },
  "3785398,-12247918": { roof: 'gable', rise: 3.4, eave: 7.5, wall: 0xdcb0a4, roofColor: 0x8a5a44, face: 90, bays: 1 },  // pink ornate Victorian under a steep gable, cxj_541000 (riding north it fronts the street)
  // downtown Bridgeway, west side, svs_541050_L to svs_541600_L
  "3785422,-12247924": { roof: 'flat', eave: 8, wall: 0xc9c2b4 },  // beige stucco commercial with a parapet
  "3785437,-12247926": { roof: 'flat', eave: 7, wall: 0xe6e2da },
  "3785447,-12247913": { roof: 'flat', eave: 7, wall: 0xf0f0ec, style: 5 },  // white clapboard, blue trim
  "3785462,-12247923": { roof: 'flat', eave: 7.5, wall: 0xb8b060 },  // olive-yellow cafe front under a green awning
  "3785470,-12247914": { roof: 'flat', eave: 7.5, wall: 0xb8b060 },
  "3785477,-12247915": { roof: 'flat', eave: 7.5, wall: 0xa04a3a, style: 5 },  // rust-red clapboard
  "3785489,-12247913": { roof: 'hip', rise: 1.2, eave: 7.5, wall: 0xa65a4a, roofColor: 0x9a4a33 },  // red-brown corner under tile
  "3785524,-12247943": { roof: 'flat', eave: 10, wall: 0x2e4466, style: 5 },  // navy clapboard, white trim, svs_541150_L
  "3785509,-12247946": { roof: 'flat', eave: 9, wall: 0xe8dcc0 },
  "3785545,-12247948": { roof: 'flat', eave: 8, wall: 0xb8a0a0 },  // mauve stucco with an arch, svs_541200_L
  "3785540,-12247942": { roof: 'flat', eave: 8, wall: 0xb8a0a0 },
  "3785550,-12247952": { roof: 'flat', eave: 8, wall: 0xe8e0cc },  // cream brick
  "3785556,-12247955": { roof: 'flat', eave: 8, wall: 0xe8e0cc },
  "3785564,-12247960": { roof: 'flat', eave: 8, wall: 0xf2f0ea },
  "3785582,-12247979": { roof: 'flat', eave: 10, wall: 0x6e4a3a, face: 61, bays: 1 },  // brown brick, white bays over white shops, svs_541250_L
  "3785600,-12247989": { roof: 'flat', eave: 8, wall: 0xe6dcc8 },  // cream classical bank front
  "3785614,-12247995": { roof: 'flat', eave: 6, wall: 0x6a5a50 },
  "3785627,-12248006": { roof: 'flat', eave: 8.5, wall: 0x7a3a2e, face: 62, bays: 1 },  // red brick, green trim, bays, black awnings, svs_541300_L
  "3785641,-12248010": { roof: 'flat', eave: 8.5, wall: 0x7a3a2e, face: 63, bays: 1 },
  "3785650,-12248015": { roof: 'flat', eave: 4.5, wall: 0x8a6a5a },  // low shops under the trees
  "3785655,-12248023": { roof: 'flat', eave: 10, wall: 0xa8b48c, face: 45, bays: 1 },  // sage Victorian, three storeys, svs_541350_L
  "3785657,-12248033": { roof: 'flat', eave: 7.5, wall: 0xe8b4a4, face: 40, bays: 1 },  // pink, a bay over a teal awning
  "3785659,-12248040": { roof: 'flat', eave: 6, wall: 0xe4e2dc },
  "3785669,-12248056": { roof: 'flat', eave: 10, wall: 0xb8bcbc },  // grey metal-sided, svs_541400_L
  "3785682,-12248079": { roof: 'flat', eave: 13, wall: 0xa4b4c4, face: 45, balconies: 0xf0f0f0 },  // pale blue hotel, white balconies
  "3785708,-12248110": { street: 1, roof: 'flat', eave: 12, wall: 0xa6b4c0, face: 45, balconies: 0xf0f0f0 },  // pale blue under scaffolding, the hotel's height
  // (A76: the hillside over svs_541450_L and 541550_L: two and three storey houses, white and pale blue under grey roofs; the lidar path ran their
  // downhill walls the whole drop, 12 to 16 m towers. Their backs go into the hill)
  "3785693,-12248131": { roof: 'hip', rise: 1.6, eave: 8, wall: 0xdfe5ea, roofColor: 0x5e6266 },
  "3785743,-12248191": { roof: 'hip', rise: 1.6, eave: 7, wall: 0xf0eee8, roofColor: 0x5e6266 },
  "3785781,-12248223": { roof: 'gable', rise: 2.2, eave: 7.5, wall: 0xc4d2dc, roofColor: 0x4e5256 },
  "3785809,-12248273": { roof: 'hip', rise: 1.4, eave: 6.5, wall: 0xe8e4da, roofColor: 0x5e6266 },
  "3785730,-12248334": { roof: 'flat', eave: 7, wall: 0xece8e0 },
  "3785718,-12248120": { street: 1, roof: 'gable', rise: 3, eave: 6, wall: 0xb0c4d6, roofColor: 0x6b665e, style: 5 },  // blue-grey clapboard house, svs_541450_L
  "3785730,-12248128": { street: 1, roof: 'hip', rise: 1.2, eave: 5, wall: 0xc8d0d8, roofColor: 0x6b665e },
  "3785739,-12248144": { street: 1, roof: 'hip', rise: 1.2, eave: 5, wall: 0xe8d4b8, roofColor: 0x6b7680 },
  "3785750,-12248155": { roof: 'hip', rise: 1.6, eave: 7, wall: 0xbcc0b4, roofColor: 0x6b665e },  // grey stucco villa with arched windows, svs_541500_L
  "3785815,-12248255": { roof: 'flat', eave: 10, wall: 0xe6dcc4, face: 45, bays: 1 },  // cream flats, svs_541600_L
  "3785362,-12247855": { roof: 'hip', rise: 2.2, eave: 6, wall: 0xf3f1ea, roofColor: 0x7c7a75 },  // the white pier building with arches
  // Bridgeway east side, the 600 block, svs_541200_R (north to south)
  "3785574,-12247919": { roof: 'flat', eave: 10.5, wall: 0xe4dac4, trim: 0x3a3a38, front: 245, awning: 0x5a6a60 },  // cream Victorian with the scrolled parapet
  "3785568,-12247910": { roof: 'flat', eave: 8, bayColor: 0xf4f2ec, wall: 0xf2f0ea, trim: 0x4a4a48, front: 248, awning: 0, face: 248, bays: 1 },  // white clapboard, one bay over the shop
  "3785555,-12247913": { roof: 'flat', eave: 7.6, bayColor: 0xf0ede6, wall: 0xa8705c, trim: 0xf0ede6, front: 239, awning: 0, face: 245, bays: 1 },  // brick with white bay windows
  "3785546,-12247905": { roof: 'flat', eave: 7.6, bayColor: 0xf0ede6, wall: 0xa8705c, trim: 0xf0ede6, front: 246, awning: 0, face: 246, bays: 1 },
  "3785540,-12247891": { roof: 'flat', eave: 8, wall: 0xc89a8a, trim: 0xece8e0, front: 249, awning: 0x2c4a6a },  // pink brick, blue awning
}));
