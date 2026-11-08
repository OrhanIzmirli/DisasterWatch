/**
 * Titles of shows and figures of speech must not pass as disaster news, and
 * real reports that share their words must. Every headline here is invented.
 */
import { describe, it, expect } from "vitest";
import { isDisasterNews } from "../src/services/newsRelevance.js";
import { isDisasterNewsIn } from "../src/services/newsLanguages.js";

const NOW = new Date("2026-11-08T10:00:00Z");
const keep = (title) => isDisasterNews({ title, url: "https://example.com/world/1", language: "en" }, { now: NOW }).keep;

describe("English: dropped", () => {
  it.each([
    "Musical - Dance of the Cyclone - The Exampleville Daily",
    "Tornado Alley the musical opens downtown",
    "Hurricane Heart wins best film at Exampleton festival",
    "New Netflix drama follows a tsunami survivor's daughter",
    "Theme park opens its Typhoon roller coaster",
  ])("a show: %s", (title) => expect(keep(title)).toBe(false));

  it.each([
    "Exampleland alliance sweeps district polls, secures landslide victory",
    "Mayor wins re-election in a landslide",
    "Governor won the race by a landslide",
    "Election earthquake topples the ruling party",
    "Voters deliver a hurricane to the incumbent",
    "Blue tsunami expected in the midterms",
    "Tsunami of criticism follows the budget",
  ])("an election or a figure of speech: %s", (title) => expect(keep(title)).toBe(false));

  it.each([
    "Shook Living Rooms Like An Earthquake: Network Joins Party Celebrations",
    "New signing hit the league like a hurricane",
    "Row erupts over council budget",
    "Violence erupted outside the stadium",
    "Crowd erupts in cheers at the final whistle",
  ])("a simile or an outburst: %s", (title) => expect(keep(title)).toBe(false));

  it.each([
    "Hurricanes beat Examplers in overtime",
    "Exampleton Storm win third straight",
    "Quarterback leads Cyclones to a touchdown record",
    "Tornado striker scores in the derby",
  ])("sport: %s", (title) => expect(keep(title)).toBe(false));
});

describe("English: real reports stay", () => {
  it.each([
    "Landslide buries village, rescuers search for survivors",
    "Mountain road cut off by a landslide",
    "Two killed in a landslide near Exampleton",
    "Volcano erupts in Exampleland",
    "Eruption sends ash over Exampleton",
    "Hurricane hits music festival in Exampleton",
    "Concert called off as typhoon nears Exampleton",
    "Theatre damaged as tornado tears through town",
    "Election postponed after earthquake in Exampleland",
    "Voters displaced by floods in Exampleland",
    "Earthquake strikes during football match, dozens injured",
    "NFL game postponed as hurricane nears",
    "It felt like an earthquake, then the tsunami warning came",
    "Tsunami of three metres reaches Exampleland",
    "Storm surge floods homes on the coast",
    "Hazards like floods and earthquakes rise in Exampleland",
  ])("%s", (title) => expect(keep(title)).toBe(true));
});

describe("Other languages", () => {
  it.each([
    ["tr", "Seçimde siyasi deprem yaşandı"],
    ["tr", "Transfer depremi: yıldız oyuncu gidiyor"],
    ["tr", "Tsunami adlı dizi Netflix'te ilk sırada"],
    ["tr", "Maçta deprem gibi gol"],
    ["es", "Contra la Tormenta y el Huracán: la película que arrasa en Netflix"],
    ["es", "Terremoto político en el parlamento de Ejemplo"],
    ["es", "Candidato promete un tsunami de votos y un terremoto en las elecciones"],
    ["es", "Erupción cutánea: cuándo ir al médico"],
    ["fr", "Vivre une catastrophe naturelle : la nouvelle attraction du parc"],
    ["fr", "Séisme politique à l'Assemblée d'Exemple"],
    ["de", "Erdrutschsieg bei der Wahl in Beispielstadt"],
    ["de", "Neuer Film über ein Erdbeben startet im Kino"],
    ["pt", "Tsunami político abala o governo de Exemplo"],
    ["pt", "Filme sobre furacão lidera as bilheterias"],
  ])("%s drops: %s", (lang, title) => expect(isDisasterNewsIn(lang, title).keep).toBe(false));

  it.each([
    ["tr", "Örnekköy'de deprem: 3 ölü, 20 yaralı"],
    ["tr", "Deprem nedeniyle maç ertelendi"],
    ["tr", "Romanya'da deprem korkuttu"], // "roman" is not a show here
    ["es", "Sismo deja heridos en un partido de la liga"],
    ["es", "Concierto cancelado por el huracán"],
    ["fr", "Le séisme fait des morts à Exemple"],
    ["fr", "Match annulé après les inondations"],
    ["de", "Erdrutsch verschüttet Straße in Beispieltal"],
    ["de", "Hochwasser: Konzert abgesagt"],
    ["pt", "Enchente deixa mortos e desalojados em Exemplo"],
    ["pt", "Jogo adiado por causa de enchentes"],
  ])("%s keeps: %s", (lang, title) => expect(isDisasterNewsIn(lang, title).keep).toBe(true));
});
