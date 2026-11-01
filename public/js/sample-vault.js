// A read-only sample collection that lives entirely in the browser.
// Opening it never creates an account or touches the server.

import { ApiError } from "./api.js";

export const SAMPLE_USER = Object.freeze({ id: "sample-vault", email: null, displayName: "Sample vault", guest: false, sample: true });
export const SAMPLE_READ_ONLY = "This is a sample vault, so it can’t be changed. Start your own vault to add tapes.";

const film = (title, year, director, actors, genre, runtime, rated, plot, extra = {}) => ({ title, year, director, actors, genre, runtime, rated, plot, ...extra });

// Newest first, like a real collection. Plots are short originals, not quotes.
const TAPES = [
  film("The Punisher", 1989, "Mark Goldblatt", ["Dolph Lundgren", "Louis Gossett Jr.", "Jeroen Krabbé"], "Action, Crime", "89 min", "R",
    "A vigilante who has spent five years in the sewers targets the mob, until a yakuza boss kidnaps the gangsters' children.",
    { label: "Live Home Video", condition: "good", status: "available", pricePaid: 3, priceAsking: 24, location: "Shelf A", notes: "Never got a US theatrical release, so tape was how most people saw it.", tags: ["Comic book"] }),
  film("Dead Heat", 1988, "Mark Goldblatt", ["Treat Williams", "Joe Piscopo", "Darren McGavin"], "Action, Comedy, Horror", "86 min", "R",
    "Two LA detectives chase robbers who refuse to stay dead, and one of the cops ends up joining their ranks.",
    { label: "New World Video", condition: "good", status: "keep", pricePaid: 4, location: "Shelf A", notes: "Same director as The Punisher. A double feature waiting to happen.", tags: ["Cult"] }),
  film("Beauty and the Beast", 1991, "Gary Trousdale, Kirk Wise", ["Paige O'Hara", "Robby Benson", "Angela Lansbury"], "Animation, Family, Musical", "84 min", "G",
    "A bookish young woman trades her freedom for her father's and finds more than a monster in an enchanted castle.",
    { label: "Walt Disney Home Video", edition: "Black Diamond", packaging: "clamshell", condition: "mint", status: "keep", pricePaid: 2, location: "Disney shelf", tags: ["Disney", "Black Diamond"] }),
  film("Jaws", 1975, "Steven Spielberg", ["Roy Scheider", "Robert Shaw", "Richard Dreyfuss"], "Adventure, Thriller", "124 min", "PG",
    "A beach town police chief, a marine scientist and a grizzled fisherman go to sea after a great white shark.",
    { label: "MCA Home Video", condition: "good", status: "available", pricePaid: 1, priceAsking: 12, location: "Shelf B", tags: ["Summer"] }),
  film("RoboCop", 1987, "Paul Verhoeven", ["Peter Weller", "Nancy Allen", "Kurtwood Smith"], "Action, Sci-Fi", "102 min", "R",
    "A murdered Detroit cop is rebuilt as a corporate law-enforcement cyborg and starts remembering who he was.",
    { label: "Orion Home Video", condition: "good", status: "sold", pricePaid: 2, priceAsking: 18, priceSold: 16, soldDate: "2026-09-20", location: "Sold", tags: ["Sci-fi"] }),
  film("The Sandlot", 1993, "David Mickey Evans", ["Tom Guiry", "Mike Vitar", "James Earl Jones"], "Comedy, Family, Sport", "101 min", "PG",
    "The new kid in town joins a neighborhood baseball crew for a summer of games, legends and one very large dog.",
    { label: "Fox Video", condition: "good", status: "keep", pricePaid: 1, location: "Shelf B", notes: "You're killing me, Smalls.", tags: ["Summer"] }),
  film("The Little Mermaid", 1989, "Ron Clements, John Musker", ["Jodi Benson", "Pat Carroll", "Samuel E. Wright"], "Animation, Family, Musical", "83 min", "G",
    "A mermaid princess makes a risky bargain with a sea witch for a chance at life on land.",
    { label: "Walt Disney Home Video", edition: "Black Diamond", packaging: "clamshell", condition: "good", status: "hold", pricePaid: 3, priceAsking: 20, location: "Disney shelf", notes: "Held for a friend.", tags: ["Disney", "Black Diamond"] }),
  film("Aladdin", 1992, "Ron Clements, John Musker", ["Scott Weinger", "Robin Williams", "Linda Larkin"], "Animation, Family, Musical", "90 min", "G",
    "A street-smart young man finds a lamp holding a wisecracking genie and a shot at winning a princess.",
    { label: "Walt Disney Home Video", edition: "Black Diamond", packaging: "clamshell", condition: "mint", status: "keep", pricePaid: 2, location: "Disney shelf", tags: ["Disney", "Black Diamond"] }),
  film("The Lion King", 1994, "Roger Allers, Rob Minkoff", ["Matthew Broderick", "James Earl Jones", "Jeremy Irons"], "Animation, Family, Musical", "88 min", "G",
    "A lion cub flees his kingdom after his father's death and must decide whether to return and face his uncle.",
    { label: "Walt Disney Home Video", edition: "Masterpiece Collection", packaging: "clamshell", condition: "sealed", sealed: true, status: "keep", pricePaid: 8, location: "Disney shelf", notes: "Still in the shrink wrap.", tags: ["Disney", "Sealed"] }),
  film("Who Framed Roger Rabbit", 1988, "Robert Zemeckis", ["Bob Hoskins", "Christopher Lloyd", "Joanna Cassidy"], "Animation, Comedy, Mystery", "104 min", "PG",
    "A hard-luck private eye who hates cartoons agrees to help a toon accused of murder.",
    { label: "Touchstone Home Video", packaging: "clamshell", condition: "good", status: "available", pricePaid: 2, priceAsking: 10, location: "Disney shelf", tags: ["Disney"] }),
  film("Back to the Future", 1985, "Robert Zemeckis", ["Michael J. Fox", "Christopher Lloyd", "Lea Thompson"], "Adventure, Comedy, Sci-Fi", "116 min", "PG",
    "A teenager lands in 1955 in a time-traveling DeLorean and has to get his parents together to make it home.",
    { label: "MCA Home Video", condition: "fair", status: "keep", pricePaid: 1, location: "Shelf B", notes: "Sleeve is worn from too many rewatches.", tags: ["Sci-fi"] }),
  film("Ghostbusters", 1984, "Ivan Reitman", ["Bill Murray", "Dan Aykroyd", "Sigourney Weaver"], "Comedy, Fantasy", "105 min", "PG",
    "Three fired parapsychologists start a ghost-removal business just as New York gets very haunted.",
    { label: "RCA/Columbia Pictures Home Video", condition: "good", status: "sold", pricePaid: 3, priceAsking: 14, priceSold: 15, soldDate: "2026-10-04", location: "Sold" }),
  film("The Goonies", 1985, "Richard Donner", ["Sean Astin", "Josh Brolin", "Corey Feldman"], "Adventure, Comedy, Family", "114 min", "PG",
    "Kids about to lose their homes follow an old treasure map into caves full of booby traps, with crooks close behind.",
    { label: "Warner Home Video", condition: "good", status: "keep", pricePaid: 2, location: "Shelf C", tags: ["Summer"] }),
  film("Gremlins", 1984, "Joe Dante", ["Zach Galligan", "Phoebe Cates", "Hoyt Axton"], "Comedy, Fantasy, Horror", "106 min", "PG",
    "A boy's unusual Christmas present comes with three rules, and his small town learns what happens when they're broken.",
    { label: "Warner Home Video", condition: "good", status: "keep", pricePaid: 1, location: "Shelf C", tags: ["Holiday", "Creature feature"] }),
  film("E.T. the Extra-Terrestrial", 1982, "Steven Spielberg", ["Henry Thomas", "Drew Barrymore", "Dee Wallace"], "Family, Sci-Fi", "115 min", "PG",
    "A lonely boy hides a stranded alien in his suburban home and helps him find a way to phone home.",
    { label: "MCA Home Video", edition: "Green tape", condition: "good", status: "keep", pricePaid: 1, location: "Shelf C", tags: ["Sci-fi"] }),
  film("Predator", 1987, "John McTiernan", ["Arnold Schwarzenegger", "Carl Weathers", "Jesse Ventura"], "Action, Sci-Fi, Thriller", "107 min", "R",
    "An elite rescue team in the Central American jungle realizes something invisible is hunting them.",
    { label: "CBS/Fox Video", condition: "good", status: "available", pricePaid: 2, priceAsking: 9, location: "Shelf A", tags: ["Creature feature"] }),
  film("Big Trouble in Little China", 1986, "John Carpenter", ["Kurt Russell", "Kim Cattrall", "Dennis Dun"], "Action, Comedy, Fantasy", "99 min", "PG-13",
    "A boastful truck driver is pulled into an underground war of sorcery beneath San Francisco's Chinatown.",
    { label: "CBS/Fox Video", condition: "good", status: "keep", pricePaid: 4, location: "Shelf A", tags: ["Cult", "Carpenter"] }),
  film("They Live", 1988, "John Carpenter", ["Roddy Piper", "Keith David", "Meg Foster"], "Action, Horror, Sci-Fi", "94 min", "R",
    "A drifter finds sunglasses that reveal hidden messages and the creatures running the world.",
    { label: "MCA Home Video", condition: "good", status: "keep", pricePaid: 3, location: "Shelf A", tags: ["Cult", "Carpenter"] }),
  film("The Return of the Living Dead", 1985, "Dan O'Bannon", ["Clu Gulager", "James Karen", "Thom Mathews"], "Comedy, Horror", "91 min", "R",
    "Two warehouse workers open a military canister and a punk-rock night at the cemetery goes very wrong.",
    { packaging: "bigbox", condition: "fair", status: "available", pricePaid: 5, priceAsking: 30, location: "Horror box", notes: "Big box with some shelf wear.", tags: ["Horror", "Cult"] }),
  film("Teen Wolf", 1985, "Rod Daniel", ["Michael J. Fox", "James Hampton", "Susan Ursitti"], "Comedy, Fantasy, Sport", "91 min", "PG",
    "A high schooler discovers he's a werewolf, which turns out to be great for his basketball game.",
    { condition: "good", status: "sold", pricePaid: 1, priceAsking: 8, priceSold: 7, soldDate: "2026-08-15", location: "Sold" }),
  film("The NeverEnding Story", 1984, "Wolfgang Petersen", ["Barret Oliver", "Noah Hathaway", "Tami Stronach"], "Adventure, Family, Fantasy", "102 min", "PG",
    "A boy hiding in a school attic reads a strange book and finds himself part of the fantasy world it describes.",
    { label: "Warner Home Video", condition: "good", status: "keep", pricePaid: 2, location: "Shelf C" }),
  film("Honey, I Shrunk the Kids", 1989, "Joe Johnston", ["Rick Moranis", "Matt Frewer", "Marcia Strassman"], "Comedy, Family, Sci-Fi", "93 min", "PG",
    "An inventor's shrink ray accidentally miniaturizes four kids, who must cross a backyard jungle to get home.",
    { label: "Walt Disney Home Video", packaging: "clamshell", condition: "good", status: "keep", pricePaid: 1, location: "Disney shelf", tags: ["Disney"] }),
  film("Tremors", 1990, "Ron Underwood", ["Kevin Bacon", "Fred Ward", "Finn Carter"], "Comedy, Horror, Sci-Fi", "96 min", "PG-13",
    "Two handymen in a tiny desert town discover giant underground worms are hunting anything that moves.",
    { label: "MCA/Universal Home Video", condition: "mint", status: "keep", pricePaid: 2, location: "Horror box", tags: ["Creature feature"] }),
  film("Jurassic Park", 1993, "Steven Spielberg", ["Sam Neill", "Laura Dern", "Jeff Goldblum"], "Adventure, Sci-Fi, Thriller", "127 min", "PG-13",
    "Scientists tour an island park of cloned dinosaurs just as its security systems fail.",
    { label: "MCA/Universal Home Video", barcode: "096898206136", condition: "good", status: "keep", pricePaid: 1, location: "Shelf B", tags: ["Creature feature"] }),
];

const DEFAULTS = { format: "VHS", artist: "", imdbRating: "", imdbId: "", posterUrl: "", edition: "", label: "", packaging: "", sealed: false, acquiredDate: "", acquiredFrom: "", barcode: "", condition: "good", status: "keep", pricePaid: null, priceAsking: null, priceSold: null, soldDate: "", location: "", notes: "", tags: [], source: "sample", estimate: null };

/** Fresh copies every time, so nothing on screen can change the originals. */
export function sampleTapes() {
  const start = Date.parse("2026-10-28T18:00:00Z");
  return TAPES.map((tape, index) => {
    const added = new Date(start - index * 3.5 * 24 * 60 * 60 * 1000).toISOString();
    return { ...DEFAULTS, ...structuredClone(tape), id: `sample-${index + 1}`, clientId: `sample-${index + 1}`, acquiredDate: added.slice(0, 10), createdAt: added, updatedAt: added };
  });
}

/** Stands in for the API while the sample vault is open: reads work, every write is refused. */
export async function sampleRequest(method, path) {
  if (method === "GET") {
    if (path === "/api/tapes") return { tapes: sampleTapes() };
    if (path === "/api/auth/me") return { user: { ...SAMPLE_USER } };
    if (path === "/api/scouts") return { lists: [] };
    if (path === "/api/settings") return { settings: {}, hasOmdbKey: false };
  }
  throw Object.assign(new ApiError(SAMPLE_READ_ONLY, 403), { code: "SAMPLE_VAULT" });
}
