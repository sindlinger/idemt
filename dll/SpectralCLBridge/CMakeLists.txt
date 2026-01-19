cmake_minimum_required(VERSION 3.20)
project(SpectralCLBridge LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(SpectralCLBridge SHARED
  SpectralCLBridge.cpp
)

target_include_directories(SpectralCLBridge PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})

target_compile_definitions(SpectralCLBridge PRIVATE _CRT_SECURE_NO_WARNINGS)

set_target_properties(SpectralCLBridge PROPERTIES
  OUTPUT_NAME "SpectralCLBridge"
)
