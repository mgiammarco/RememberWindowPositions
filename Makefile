SCRIPT_NAME := rememberwindowpositions
PKGFILE := $(SCRIPT_NAME).kwinscript
SRC_DIR := src
# Plasma 6 ships the binary as qdbus6; the bare `qdbus` wrapper fails here with
# "could not find a Qt installation of ''". Pin it explicitly.
QDBUS := qdbus6
# Canonical location kpackagetool6 installs the script to.
INSTALL_DIR := $(HOME)/.local/share/kwin/scripts/$(SCRIPT_NAME)
SESSION_WIDTH := 1920
SESSION_HEIGHT := 1080
SESSION_OUTPUT_COUNT := 1
SESSION_VERBOSE := 0
SESSION_APPLICATIONS := # dolphin konsole kate

.NOTPARALLEL: all

.PHONY: all build install uninstall clean enable disable restart-kwin logs load unload reload reload-installed remove-keybindings

all: install clean

build: $(PKGFILE)

$(PKGFILE): $(shell find $(SRC_DIR) -type f)
	@echo "Packaging $(SRC_DIR) into $(PKGFILE)..."
	@zip -rq $(PKGFILE) $(SRC_DIR)

install: build
	@echo "Installing $(PKGFILE)..."
	@kpackagetool6 --type=KWin/Script -i $(PKGFILE) || \
	kpackagetool6 --type=KWin/Script -u $(PKGFILE)

uninstall:
	@echo "Uninstalling $(SCRIPT_NAME)..."
	@kpackagetool6 --type=KWin/Script -r $(SCRIPT_NAME)

clean:
	@echo "Cleaning up $(PKGFILE)..."
	@rm -f $(PKGFILE)

enable:
	@echo "Enabling $(SCRIPT_NAME)..."
	@kwriteconfig6 --file kwinrc --group Plugins --key $(SCRIPT_NAME)Enabled true
	@$(QDBUS) org.kde.KWin /KWin reconfigure

disable:
	@echo "Disabling $(SCRIPT_NAME)..."
	@kwriteconfig6 --file kwinrc --group Plugins --key $(SCRIPT_NAME)Enabled false
	@$(QDBUS) org.kde.KWin /KWin reconfigure

restart-kwin:
	if [ "$$XDG_SESSION_TYPE" = "x11" ]; then \
		kwin_x11 --replace & \
	elif [ "$$XDG_SESSION_TYPE" = "wayland" ]; then \
		kwin_wayland --replace & \
	else \
		echo "Unknown session type"; \
	fi

logs:
	@if [ "${XDG_SESSION_TYPE}" = "x11" ]; then \
	    journalctl -f -t kwin_x11; \
	else \
	    journalctl --user -u plasma-kwin_wayland -f QT_CATEGORY=js QT_CATEGORY=qml QT_CATEGORY=kwin_scripting; \
	fi

load:
	bin/load.sh "$(SRC_DIR)" "$(SCRIPT_NAME)-test"

unload:
	bin/unload.sh "$(SCRIPT_NAME)-test"

reload: unload load

# Reload the INSTALLED script's code into the running session, no relogin needed.
# `$(QDBUS) ... reconfigure` does NOT reload script code on Plasma 6 (and does not
# unload on Enabled=false); only an explicit /Scripting unload+load does, which is
# what bin/unload.sh + bin/load.sh perform. Global shortcuts registered at the
# previous boot survive this reload. NOTE: a brand-new ShortcutHandler name still
# needs a full relogin to register (see docs / project memory).
reload-installed: install
	bin/unload.sh "$(SCRIPT_NAME)" || true
	bin/load.sh "$(INSTALL_DIR)" "$(SCRIPT_NAME)"

remove-keybindings:
	@echo "Removing all unused custom keybindings..."
	$(QDBUS) org.kde.kglobalaccel /component/kwin org.kde.kglobalaccel.Component.cleanUp
