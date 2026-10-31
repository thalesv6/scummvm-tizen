# Toolchain to build ScummVM (WebAssembly) and package it as a Tizen .wgt.
# Packaging setup adapted from dos-ise/openttd-tizen (os/tizen/Dockerfile).
FROM ubuntu:22.04

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y \
	autoconf automake libtool pkg-config build-essential cmake \
	git wget curl ca-certificates python3 xz-utils zip unzip expect default-jre \
	&& rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash builder
USER builder
WORKDIR /home/builder

RUN wget -nv -O cli.bin 'https://download.tizen.org/sdk/Installer/tizen-studio_6.1/web-cli_Tizen_Studio_6.1_ubuntu-64.bin' \
	&& chmod +x cli.bin && ./cli.bin --accept-license --no-java-check /home/builder/tizen-studio && rm cli.bin
ENV PATH=/home/builder/tizen-studio/tools/ide/bin:/home/builder/tizen-studio/tools:${PATH}

# Throwaway author certificate: Apps2Samsung re-signs the .wgt with the TV's own certificate on install.
RUN tizen certificate -a scummvm -f scummvm -p 1234 \
	&& tizen security-profiles add -n scummvm -a /home/builder/tizen-studio-data/keystore/author/scummvm.p12 -p 1234 \
	&& sed -i 's|/home/builder/tizen-studio-data/keystore/author/scummvm.pwd||' /home/builder/tizen-studio-data/profile/profiles.xml \
	&& sed -i 's|/home/builder/tizen-studio-data/tools/certificate-generator/certificates/distributor/tizen-distributor-signer.pwd|tizenpkcs12passfordsigner|' /home/builder/tizen-studio-data/profile/profiles.xml
