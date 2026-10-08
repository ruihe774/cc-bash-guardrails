#!/bin/sh
helm upgrade --kube-context "shop-$1" shopfront ./chart
