/**
 * Unambiguous major cities and well-known provinces/islands -> ISO alpha-2.
 * Used only to confirm (or contradict) the country a GDACS article inherits
 * from its event (src/services/newsLocation.js); never to place an article
 * on its own.
 *
 * Names shared by places in different countries are left out on purpose
 * (Tripoli: Libya and Lebanon; Hyderabad: India and Pakistan; Valencia,
 * Santiago, Perth, Victoria, Alexandria, Lagos, Guadalajara, ...), as are
 * city names that double as team names (Miami, ...). Keys are lower-case
 * and accent-free.
 */
const CITIES = {
  TR: ["istanbul", "ankara", "izmir", "antalya", "bursa", "adana", "gaziantep", "konya", "kahramanmaras", "hatay", "antakya", "malatya", "diyarbakir", "trabzon", "mersin", "bodrum"],
  ID: ["jakarta", "padang", "surabaya", "bandung", "medan", "semarang", "makassar", "palembang", "yogyakarta", "denpasar", "palu", "manado", "pekanbaru", "banda aceh", "sumatra", "sulawesi", "kalimantan", "bali", "lombok"],
  NP: ["kathmandu", "pokhara", "lalitpur", "bhaktapur"],
  PK: ["karachi", "lahore", "islamabad", "peshawar", "quetta", "rawalpindi", "multan", "faisalabad", "khuzdar", "balochistan", "sindh", "khyber pakhtunkhwa"],
  IN: ["mumbai", "delhi", "new delhi", "kolkata", "chennai", "bengaluru", "bangalore", "ahmedabad", "pune", "kerala", "assam", "odisha", "shimla", "himachal pradesh", "uttarakhand", "tamil nadu", "gujarat"],
  CN: ["beijing", "shanghai", "guangzhou", "shenzhen", "chongqing", "chengdu", "wuhan", "sichuan", "yunnan", "guangdong", "fujian", "xinjiang"],
  JP: ["tokyo", "osaka", "kyoto", "yokohama", "sapporo", "fukuoka", "kobe", "sendai", "hokkaido", "okinawa", "kyushu", "honshu"],
  PH: ["manila", "cebu", "davao", "quezon city", "luzon", "mindanao", "visayas", "leyte"],
  VN: ["hanoi", "ho chi minh city", "da nang", "haiphong"],
  TH: ["bangkok", "chiang mai", "phuket"],
  MY: ["kuala lumpur", "sabah", "sarawak", "penang"],
  BD: ["dhaka", "chittagong", "sylhet"],
  MM: ["yangon", "mandalay", "naypyidaw"],
  LK: ["colombo"],
  AF: ["kabul", "herat", "kandahar"],
  IR: ["tehran", "mashhad", "isfahan", "shiraz", "tabriz"],
  IQ: ["baghdad", "basra", "mosul", "erbil"],
  SY: ["damascus", "aleppo", "homs", "latakia"],
  LB: ["beirut"],
  EG: ["cairo", "giza"],
  LY: ["benghazi", "derna", "misrata"],
  MA: ["casablanca", "marrakech", "marrakesh", "rabat", "agadir"],
  DZ: ["algiers"],
  TN: ["tunis"],
  NG: ["abuja", "kano", "ibadan"],
  KE: ["nairobi", "mombasa"],
  ET: ["addis ababa"],
  ZA: ["johannesburg", "cape town", "durban", "pretoria"],
  MZ: ["maputo"],
  MG: ["antananarivo"],
  CD: ["kinshasa", "goma"],
  SO: ["mogadishu"],
  SD: ["khartoum"],
  MX: ["monterrey", "acapulco", "tijuana", "cancun", "oaxaca", "veracruz", "tabasco", "chiapas", "jalisco", "sinaloa", "baja california"],
  CA: ["toronto", "vancouver", "montreal", "calgary"],
  BR: ["sao paulo", "rio de janeiro", "rio grande do sul", "porto alegre", "brasilia", "recife", "manaus", "belo horizonte"],
  AR: ["buenos aires"],
  CL: ["valparaiso", "vina del mar"],
  PE: ["cusco", "arequipa"],
  CO: ["bogota", "medellin", "barranquilla"],
  EC: ["quito", "guayaquil"],
  VE: ["caracas"],
  HT: ["port-au-prince"],
  CU: ["havana"],
  IT: ["milan", "naples", "venice", "florence", "sicily", "sardinia", "emilia-romagna", "tuscany", "bologna", "turin", "palermo"],
  GR: ["thessaloniki", "crete", "rhodes", "evia"],
  ES: ["madrid", "barcelona", "seville", "malaga", "mallorca", "majorca"],
  PT: ["lisbon", "madeira"],
  FR: ["marseille", "lyon", "toulouse", "corsica"],
  DE: ["berlin", "munich", "hamburg", "cologne", "frankfurt", "bavaria"],
  GB: ["edinburgh", "glasgow", "cardiff"],
  UA: ["kyiv", "kharkiv", "odesa"],
  RU: ["moscow", "kamchatka", "siberia", "dagestan", "sochi"],
  AU: ["brisbane", "adelaide", "queensland", "new south wales", "tasmania"],
  NZ: ["auckland", "christchurch"],
  PG: ["port moresby"],
  FJ: ["suva"],
  TW: ["taipei", "kaohsiung", "hualien"],
  KR: ["seoul", "busan", "incheon"],
};

/** [place, code] pairs, longest names first ("new delhi" before "delhi"). */
export const CITY_COUNTRY = Object.entries(CITIES)
  .flatMap(([code, names]) => names.map((n) => [n, code]))
  .sort((a, b) => b[0].length - a[0].length);
