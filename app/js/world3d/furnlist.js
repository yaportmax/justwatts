// (A37) Roadside furniture the generated world lacks, off the Street View survey (the photos cz_<station>_a, ahead along
// the stations) and OpenStreetMap: placed along the roads' lines (conzelman.js compileSpec: station, side of the line,
// metres past that side's paved edge), standing on the lidar's ground. view.js buildFurniture draws them.

// utility poles OpenStreetMap lacks, as chains (wires from each pole to the next): [[station, side 'L' | 'R', past the
// edge, arm (a cobra-head light toward the road), osm (OpenStreetMap's pole, drawn already: only its wires and arm)], ...]
export const POLES = [
  // Bunker Road at Fort Cronkhite's barracks: the line crosses the road; the left pole (OSM's, 33422) carries a street light
  // over the road (w_bunker3, cz_33410_a)
  { src: 'w_bunker3', pts: [[33422, 'L', 1.2, true, true], [33421, 'R', 2.4]] },
  // Alexander Avenue above the lower road: two poles behind the rail on the bay side (w_alexander1: about 17 m ahead and
  // past the 25 MPH sign; the camera faces against the stations)
  { src: 'w_alexander1', pts: [[20318, 'L', 4.8], [20285, 'L', 5.0]] },
];

// single pieces: [station, side, past the edge, kind (props.js furnitureGeometries), src]
export const PIECES = [
  // a utility cabinet at the back of the dirt pull-off by the McCullough junction (w_mccullough2, cz_33290_a: about 21 m
  // ahead on the right, against the stations)
  [33269, 'L', 6.5, 'ubox', 'w_mccullough2'],
  // McCullough Road's white delineators on the bends, a metre off the edge (estimated along the road from the lane's width
  // in each photo)
  [70145, 'R', 1.0, 'rdelin', 'cz_70105_a'], [70220, 'R', 1.0, 'rdelin', 'cz_70195_a'],
  [70354, 'L', 1.0, 'rdelin', 'cz_70335_a'], [70375, 'L', 1.5, 'rdelin', 'cz_70365_a'], [70388, 'R', 1.0, 'rdelin', 'cz_70335_a, cz_70365_a'],
  [70405, 'L', 1.0, 'rdelin', 'w_mccullough0'], [70500, 'R', 1.0, 'rdelin', 'cz_70485_a'], [70511, 'L', 1.0, 'rdelin', 'cz_70505_a'],
  [70542, 'R', 1.0, 'rdelin', 'cz_70530_a'], [70565, 'R', 1.0, 'rdelin', 'cz_70550_a'], [71074, 'L', 1.0, 'rdelin', 'cz_71070_a'], [71180, 'R', 1.0, 'rdelin', 'cz_71160_a'],
];

// OpenStreetMap's street lamps (highway=street_lamp) beside the Headlands' roads (within 10 m of a line): [lat, lon]; the
// lamp's arm toward the nearest road (Alexander Avenue's, w_alexander1)
export const LAMPS = [
  [37.844316, -122.4780669], [37.8437457, -122.4782694], [37.8453242, -122.4779757],
  [37.8354721, -122.4849709], [37.8341323, -122.4842596], [37.8338454, -122.4838655], [37.8393894, -122.4870957],
  [37.8469216, -122.479793], [37.8469359, -122.4808308], [37.8473599, -122.4808409],
];
