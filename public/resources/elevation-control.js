class ElevationInfoControl {
    constructor(options) {
      this.url = options["url"];
    }

    getDefaultPosition() {
      const defaultPosition = "bottom-left";
      return defaultPosition;
    }

    onAdd(map) {
      this.map = map;
      this.controlContainer = document.createElement("div");
      this.controlContainer.classList.add("maplibregl-ctrl");
      this.controlContainer.classList.add("maplibregl-ctrl-group");
      this.controlContainer.textContent = "elevation info";
      return this.controlContainer;
    }

    onRemove() {
      if (
        !this.controlContainer ||
        !this.controlContainer.parentNode ||
        !this.map
      ) {
        return;
      }
      this.controlContainer.parentNode.removeChild(this.controlContainer);
      this.map = undefined;
    }
  };
