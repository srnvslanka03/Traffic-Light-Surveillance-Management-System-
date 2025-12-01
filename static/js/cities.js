const resultsContainer = document.getElementById("cityResults");
const form = document.getElementById("citySearchForm");
const input = document.getElementById("citySearchInput");
const countLabel = document.getElementById("citySearchCount");

async function fetchCities(query = "") {
  const url = query ? `/api/cities?q=${encodeURIComponent(query)}` : "/api/cities";
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch cities: ${response.statusText}`);
  }
  return response.json();
}

function createCityCard(item) {
  const wrapper = document.createElement("article");
  wrapper.className = "city-card";

  const header = document.createElement("header");
  header.className = "city-card__header";
  header.innerHTML = `
    <div>
      <h3>${item.city}, ${item.state}</h3>
      <p class="city-card__classification">${item.classification.replace("_", " ")}</p>
    </div>
    <div class="city-card__score">
      <span class="score">${item.suitability.score}</span>
      <span class="label">${item.suitability.priority} priority</span>
    </div>
  `;
  wrapper.appendChild(header);

  const metricGrid = document.createElement("div");
  metricGrid.className = "city-card__metrics";
  metricGrid.innerHTML = `
    <div>
      <span class="metric-label">Avg delay</span>
      <span class="metric-value">${item.avg_delay_minutes} min</span>
    </div>
    <div>
      <span class="metric-label">Peak speed</span>
      <span class="metric-value">${item.avg_peak_speed_kmph} km/h</span>
    </div>
    <div>
      <span class="metric-label">Population</span>
      <span class="metric-value">${item.population_millions.toFixed(1)} M</span>
    </div>
  `;
  wrapper.appendChild(metricGrid);

  const issues = document.createElement("div");
  issues.className = "city-card__section";
  issues.innerHTML = `
    <h4>Current challenges</h4>
    <ul>${item.issues.map((issue) => `<li>${issue}</li>`).join("")}</ul>
  `;
  wrapper.appendChild(issues);

  const actions = document.createElement("div");
  actions.className = "city-card__section actions";
  actions.innerHTML = `
    <h4>How the platform helps</h4>
    <ul>${item.recommended_actions.map((action) => `<li>${action}</li>`).join("")}</ul>
  `;
  wrapper.appendChild(actions);

  const rationale = document.createElement("div");
  rationale.className = "city-card__section rationale";
  rationale.innerHTML = `
    <h4>Suitability rationale</h4>
    <p>${item.suitability.rationale.join(" • ")}</p>
  `;
  wrapper.appendChild(rationale);

  return wrapper;
}

function renderCityResults(data) {
  resultsContainer.innerHTML = "";
  if (!data.items || data.items.length === 0) {
    const emptyState = document.createElement("div");
    emptyState.className = "city-empty";
    emptyState.innerHTML = `
      <h3>No cities found</h3>
      <p>Try searching by state name, metro type, or another spelling.</p>
    `;
    resultsContainer.appendChild(emptyState);
    countLabel.textContent = "No matches";
    return;
  }

  const fragment = document.createDocumentFragment();
  data.items.forEach((item) => {
    fragment.appendChild(createCityCard(item));
  });
  resultsContainer.appendChild(fragment);

  countLabel.textContent = data.count ? `${data.count} city recommendations` : "Showing featured cities";
}

async function handleSearch(event) {
  event.preventDefault();
  const query = input.value.trim();
  try {
    countLabel.textContent = "Loading...";
    const data = await fetchCities(query);
    renderCityResults(data);
  } catch (error) {
    console.error(error);
    resultsContainer.innerHTML = `
      <div class="city-error">
        <h3>Could not load cities</h3>
        <p>${error.message}</p>
      </div>
    `;
    countLabel.textContent = "Error loading data";
  }
}

form?.addEventListener("submit", handleSearch);

// auto-load featured cities
fetchCities()
  .then(renderCityResults)
  .catch((error) => {
    console.error(error);
    resultsContainer.innerHTML = `
      <div class="city-error">
        <h3>Could not load cities</h3>
        <p>${error.message}</p>
      </div>
    `;
  });
