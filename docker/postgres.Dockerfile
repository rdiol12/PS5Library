FROM postgres:18-alpine@sha256:6c538e7206ea40ff740ef27883529390a690b6ead6ba96b44c67a9f7c638e8fd

USER root
RUN rm /usr/local/bin/gosu
USER postgres
